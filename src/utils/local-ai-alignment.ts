import {
    type AlignerChunkRequest,
    alignerChunkRequestType,
    type AlignerCleanupRequest,
    alignerCleanupRequestType,
    type AlignerCommitRequest,
    alignerCommitRequestType,
    alignerResponseType,
    type AlignerResultRequest,
    alignerResultRequestType,
    type AlignerStartRequest,
    alignerStartRequestType,
    type AlignerStatusRequest,
    alignerStatusRequestType,
    type LocalAlignerJob,
    localAlignerMaxAudioBytes,
    type LocalAlignerPayload,
    type LocalAlignerRequest,
    type LocalAlignerResponse,
} from "../shared/local-aligner-protocol.js";
import { mediaExtensionAckType } from "../shared/media-extension-protocol.js";

export class LocalAiAlignmentError extends Error {
    constructor(readonly code: "missing" | "outdated" | "not-running" | "busy" | "failed", message: string) {
        super(message);
        this.name = LocalAiAlignmentError.name;
    }
}

export interface LocalAlignmentProgress {
    phase: "connecting" | "uploading" | "queued" | "running" | "cleaning" | "complete";
    progress: number;
    detail?: string;
    remainingSeconds?: number;
}

export interface LocalAlignmentOptions {
    audio: Blob;
    audioName: string;
    transcript: string;
    precision: 2 | 3;
    keepTaskCache: boolean;
    onProgress?: (progress: LocalAlignmentProgress) => void;
}

export interface LocalAlignmentResult {
    lrc: string;
    cacheCleanup: "kept" | "deleted" | "failed";
    reclaimedBytes?: number;
}

const minimumAlignerExtensionVersion = [0, 4, 2] as const;

export const runLocalAiAlignment = async (options: LocalAlignmentOptions): Promise<LocalAlignmentResult> => {
    if (options.audio.size <= 0 || options.audio.size > localAlignerMaxAudioBytes) {
        throw new LocalAiAlignmentError("failed", "The loaded media size is not supported for local alignment");
    }
    options.onProgress?.({ phase: "connecting", progress: 0.01 });
    const startPayload = await requestAligner(
        {
            type: alignerStartRequestType,
            requestId: crypto.randomUUID(),
            audioName: options.audioName,
            audioType: options.audio.type || "application/octet-stream",
            audioSize: options.audio.size,
            transcript: options.transcript,
            separate: true,
            bypassCache: !options.keepTaskCache,
            preserveBlankLines: true,
            wordTimingBeta: false,
        } satisfies AlignerStartRequest,
        8_000,
    );
    if (startPayload.kind !== "start") throw new LocalAiAlignmentError("failed", "Invalid aligner start response");

    const totalChunks = Math.ceil(options.audio.size / startPayload.chunkSize);
    for (let index = 0; index < totalChunks; index += 1) {
        const start = index * startPayload.chunkSize;
        const chunk = options.audio.slice(start, Math.min(start + startPayload.chunkSize, options.audio.size));
        const payload = await requestAligner(
            {
                type: alignerChunkRequestType,
                requestId: crypto.randomUUID(),
                uploadId: startPayload.uploadId,
                index,
                data: encodeBase64(new Uint8Array(await chunk.arrayBuffer())),
            } satisfies AlignerChunkRequest,
            15_000,
        );
        if (payload.kind !== "chunk") throw new LocalAiAlignmentError("failed", "Invalid aligner upload response");
        options.onProgress?.({
            phase: "uploading",
            progress: Math.min(0.15, 0.02 + 0.13 * payload.received / options.audio.size),
        });
    }

    const commitPayload = await requestAligner(
        {
            type: alignerCommitRequestType,
            requestId: crypto.randomUUID(),
            uploadId: startPayload.uploadId,
        } satisfies AlignerCommitRequest,
        120_000,
    );
    if (commitPayload.kind !== "job") throw new LocalAiAlignmentError("failed", "Invalid aligner job response");

    let job = commitPayload.job;
    const etaEstimator = new ProgressEtaEstimator();
    while (job.status === "queued" || job.status === "running") {
        reportJob(job, etaEstimator, options.onProgress);
        await new Promise((resolve) => setTimeout(resolve, 900));
        const statusPayload = await requestAligner(
            {
                type: alignerStatusRequestType,
                requestId: crypto.randomUUID(),
                baseUrl: commitPayload.baseUrl,
                jobId: job.id,
            } satisfies AlignerStatusRequest,
            15_000,
        );
        if (statusPayload.kind !== "job") throw new LocalAiAlignmentError("failed", "Invalid aligner status response");
        job = statusPayload.job;
    }
    if (job.status !== "complete") {
        throw new LocalAiAlignmentError("failed", job.error || "Local alignment failed");
    }
    options.onProgress?.({ phase: "complete", progress: 0.99, detail: job.detail });

    const resultPayload = await requestAligner(
        {
            type: alignerResultRequestType,
            requestId: crypto.randomUUID(),
            baseUrl: commitPayload.baseUrl,
            jobId: job.id,
            precision: options.precision,
        } satisfies AlignerResultRequest,
        15_000,
    );
    if (resultPayload.kind !== "result" || !resultPayload.lrc.trim()) {
        throw new LocalAiAlignmentError("failed", "Aligned LRC was empty");
    }

    if (options.keepTaskCache) {
        options.onProgress?.({ phase: "complete", progress: 1, detail: job.detail });
        return { lrc: resultPayload.lrc, cacheCleanup: "kept" };
    }

    options.onProgress?.({ phase: "cleaning", progress: 0.995 });
    try {
        const cleanupPayload = await requestAligner(
            {
                type: alignerCleanupRequestType,
                requestId: crypto.randomUUID(),
                baseUrl: commitPayload.baseUrl,
                jobId: job.id,
            } satisfies AlignerCleanupRequest,
            30_000,
        );
        if (cleanupPayload.kind !== "cleanup") {
            throw new LocalAiAlignmentError("failed", "Invalid aligner cleanup response");
        }
        options.onProgress?.({ phase: "complete", progress: 1, detail: job.detail });
        return {
            lrc: resultPayload.lrc,
            cacheCleanup: "deleted",
            reclaimedBytes: cleanupPayload.reclaimedBytes,
        };
    } catch {
        options.onProgress?.({ phase: "complete", progress: 1, detail: job.detail });
        return { lrc: resultPayload.lrc, cacheCleanup: "failed" };
    }
};

const reportJob = (
    job: LocalAlignerJob,
    etaEstimator: ProgressEtaEstimator,
    callback?: (progress: LocalAlignmentProgress) => void,
): void => {
    const engineProgress = Math.max(0, Math.min(1, job.progress || 0));
    callback?.({
        phase: job.status === "queued" ? "queued" : "running",
        progress: 0.15 + 0.83 * engineProgress,
        detail: job.detail,
        remainingSeconds: job.status === "running" ? etaEstimator.update(engineProgress) : undefined,
    });
};

export class ProgressEtaEstimator {
    private readonly samples: { progress: number; time: number }[] = [];
    private smoothedSeconds: number | undefined;

    constructor(private readonly now: () => number = () => performance.now()) {}

    update(progress: number): number | undefined {
        const normalized = Math.max(0, Math.min(1, progress));
        if (normalized <= 0 || normalized >= 1) return undefined;

        const time = this.now();
        const last = this.samples.at(-1);
        if (!last || normalized > last.progress) {
            this.samples.push({ progress: normalized, time });
        } else if (normalized === last.progress) {
            last.time = time;
        }

        while (this.samples.length > 2 && time - this.samples[0].time > 30_000) {
            this.samples.shift();
        }
        if (this.samples.length < 2) return undefined;

        const first = this.samples[0];
        const current = this.samples.at(-1)!;
        const elapsedSeconds = (current.time - first.time) / 1000;
        const completed = current.progress - first.progress;
        if (elapsedSeconds < 4 || completed < 0.01) return this.smoothedSeconds && Math.ceil(this.smoothedSeconds);

        const rawSeconds = (1 - normalized) / (completed / elapsedSeconds);
        if (!Number.isFinite(rawSeconds) || rawSeconds <= 0) return undefined;
        const bounded = Math.max(1, Math.min(7_200, rawSeconds));
        this.smoothedSeconds = this.smoothedSeconds === undefined
            ? bounded
            : this.smoothedSeconds * 0.7 + bounded * 0.3;
        return Math.ceil(this.smoothedSeconds);
    }
}

const requestAligner = (request: LocalAlignerRequest, timeoutMs: number): Promise<LocalAlignerPayload> =>
    new Promise((resolve, reject) => {
        let responseTimeout = 0;
        const extensionTimeout = window.setTimeout(() => {
            finish();
            reject(new LocalAiAlignmentError("missing", "Media Bridge did not respond"));
        }, 1_500);

        const finish = (): void => {
            window.clearTimeout(extensionTimeout);
            window.clearTimeout(responseTimeout);
            window.removeEventListener("message", onMessage);
        };

        const onMessage = (event: MessageEvent<unknown>): void => {
            if (event.source !== window || event.origin !== location.origin) return;
            if (isAck(event.data, request.requestId)) {
                window.clearTimeout(extensionTimeout);
                if (!isSupportedVersion(event.data.version)) {
                    finish();
                    reject(new LocalAiAlignmentError("outdated", "Media Bridge is too old for AI alignment"));
                    return;
                }
                responseTimeout = window.setTimeout(() => {
                    finish();
                    reject(new LocalAiAlignmentError("failed", "Local aligner request timed out"));
                }, timeoutMs);
                return;
            }
            if (!isAlignerResponse(event.data, request.requestId)) return;
            finish();
            if (!event.data.ok) {
                const code = event.data.error === "ALIGNER_NOT_RUNNING"
                    ? "not-running"
                    : event.data.error === "ALIGNER_BUSY"
                    ? "busy"
                    : "failed";
                reject(new LocalAiAlignmentError(code, event.data.message || event.data.error));
                return;
            }
            resolve(event.data.payload);
        };

        window.addEventListener("message", onMessage);
        window.postMessage(request, location.origin);
    });

const isAck = (
    value: unknown,
    requestId: string,
): value is { type: typeof mediaExtensionAckType; requestId: string; version?: string } => {
    if (typeof value !== "object" || value === null) return false;
    const response = value as Record<string, unknown>;
    return response.type === mediaExtensionAckType && response.requestId === requestId;
};

const isAlignerResponse = (value: unknown, requestId: string): value is LocalAlignerResponse => {
    if (typeof value !== "object" || value === null) return false;
    const response = value as Partial<LocalAlignerResponse>;
    return response.type === alignerResponseType && response.requestId === requestId
        && typeof response.ok === "boolean";
};

const isSupportedVersion = (version: string | undefined): boolean => {
    if (!version) return false;
    const current = version.split(".").map((part) => Number.parseInt(part, 10));
    for (const [index, minimum] of minimumAlignerExtensionVersion.entries()) {
        const value = current[index] || 0;
        if (value > minimum) return true;
        if (value < minimum) return false;
    }
    return true;
};

const encodeBase64 = (bytes: Uint8Array): string => {
    let binary = "";
    for (let index = 0; index < bytes.length; index += 32_768) {
        binary += String.fromCharCode(...bytes.subarray(index, index + 32_768));
    }
    return btoa(binary);
};
