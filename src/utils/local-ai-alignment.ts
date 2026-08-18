import {
    type AlignerChunkRequest,
    alignerChunkRequestType,
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
    phase: "connecting" | "uploading" | "queued" | "running" | "complete";
    progress: number;
    detail?: string;
}

export interface LocalAlignmentOptions {
    audio: Blob;
    audioName: string;
    transcript: string;
    precision: 2 | 3;
    onProgress?: (progress: LocalAlignmentProgress) => void;
}

const minimumAlignerExtensionVersion = [0, 4, 0] as const;

export const runLocalAiAlignment = async (options: LocalAlignmentOptions): Promise<string> => {
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
            bypassCache: false,
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
    while (job.status === "queued" || job.status === "running") {
        reportJob(job, options.onProgress);
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
    options.onProgress?.({ phase: "complete", progress: 1, detail: job.detail });
    return resultPayload.lrc;
};

const reportJob = (
    job: LocalAlignerJob,
    callback?: (progress: LocalAlignmentProgress) => void,
): void => {
    callback?.({
        phase: job.status === "queued" ? "queued" : "running",
        progress: 0.15 + 0.83 * Math.max(0, Math.min(1, job.progress || 0)),
        detail: job.detail,
    });
};

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
