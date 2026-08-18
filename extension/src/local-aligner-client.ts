import {
    type AlignerCacheClearRequest,
    alignerCacheClearRequestType,
    type AlignerCancelRequest,
    alignerCancelRequestType,
    type AlignerChunkRequest,
    alignerChunkRequestType,
    type AlignerCleanupRequest,
    alignerCleanupRequestType,
    type AlignerCommitRequest,
    alignerCommitRequestType,
    type AlignerResultRequest,
    alignerResultRequestType,
    type AlignerServiceStopRequest,
    alignerServiceStopRequestType,
    type AlignerStartRequest,
    alignerStartRequestType,
    type AlignerStatusRequest,
    alignerStatusRequestType,
    localAlignerChunkSize,
    type LocalAlignerJob,
    type LocalAlignerPayload,
    localAlignerPorts,
    type LocalAlignerRequest,
} from "../../src/shared/local-aligner-protocol.js";

export class LocalAlignerClientError extends Error {
    constructor(
        readonly code: "ALIGNER_NOT_RUNNING" | "ALIGNER_BUSY" | "INVALID_REQUEST" | "UPLOAD_LOST" | "ALIGNER_FAILED",
        message: string,
    ) {
        super(message);
        this.name = LocalAlignerClientError.name;
    }
}

interface UploadSession {
    baseUrl: string;
    serviceVersion: string;
    audioName: string;
    audioType: string;
    audioSize: number;
    transcript: string;
    separate: boolean;
    bypassCache: boolean;
    preserveBlankLines: boolean;
    wordTimingBeta: boolean;
    device: "auto" | "cpu";
    parts: Uint8Array<ArrayBuffer>[];
    received: number;
    updatedAt: number;
    cancelled: boolean;
    committing: boolean;
}

export class LocalAlignerClient {
    private readonly uploads = new Map<string, UploadSession>();
    private readonly cancelledUploads = new Map<string, number>();
    private cachedService: { baseUrl: string; version: string } | undefined;
    private startLocked = false;
    private commitLocked = false;

    constructor(private readonly fetchFn: typeof fetch = (input, init) => globalThis.fetch(input, init)) {}

    async handle(request: LocalAlignerRequest): Promise<LocalAlignerPayload> {
        switch (request.type) {
            case alignerStartRequestType:
                return await this.start(request);
            case alignerChunkRequestType:
                return this.chunk(request);
            case alignerCommitRequestType:
                return await this.commit(request);
            case alignerStatusRequestType:
                return await this.status(request);
            case alignerResultRequestType:
                return await this.result(request);
            case alignerCleanupRequestType:
                return await this.cleanup(request);
            case alignerCancelRequestType:
                return await this.cancel(request);
            case alignerServiceStopRequestType:
                return await this.stopService(request);
            case alignerCacheClearRequestType:
                return await this.clearCache(request);
        }
    }

    private async start(request: AlignerStartRequest): Promise<LocalAlignerPayload> {
        this.removeExpiredUploads();
        if (this.startLocked || this.commitLocked || this.uploads.size > 0) {
            throw new LocalAlignerClientError("ALIGNER_BUSY", "A local alignment task is already being prepared");
        }
        this.startLocked = true;
        try {
            const service = await this.findService();
            await this.ensureServiceIdle(service.baseUrl);
            if (this.cancelledUploads.delete(request.uploadId)) {
                throw new LocalAlignerClientError("UPLOAD_LOST", "Local alignment upload was stopped");
            }
            this.uploads.set(request.uploadId, {
                baseUrl: service.baseUrl,
                serviceVersion: service.version,
                audioName: sanitizeFileName(request.audioName),
                audioType: request.audioType || "application/octet-stream",
                audioSize: request.audioSize,
                transcript: request.transcript,
                separate: request.separate,
                bypassCache: request.bypassCache,
                preserveBlankLines: request.preserveBlankLines,
                wordTimingBeta: request.wordTimingBeta,
                device: request.useGpuAcceleration ? "auto" : "cpu",
                parts: [],
                received: 0,
                updatedAt: Date.now(),
                cancelled: false,
                committing: false,
            });
            return {
                kind: "start",
                uploadId: request.uploadId,
                baseUrl: service.baseUrl,
                chunkSize: localAlignerChunkSize,
                serviceVersion: service.version,
            };
        } finally {
            this.startLocked = false;
        }
    }

    private chunk(request: AlignerChunkRequest): LocalAlignerPayload {
        const upload = this.uploads.get(request.uploadId);
        if (!upload) throw new LocalAlignerClientError("UPLOAD_LOST", "Local alignment upload expired");
        if (upload.cancelled) throw new LocalAlignerClientError("UPLOAD_LOST", "Local alignment upload was stopped");
        if (request.index !== upload.parts.length) {
            throw new LocalAlignerClientError("INVALID_REQUEST", "Local alignment chunks are out of order");
        }
        const part = decodeBase64(request.data);
        if (part.byteLength === 0 || upload.received + part.byteLength > upload.audioSize) {
            throw new LocalAlignerClientError("INVALID_REQUEST", "Local alignment chunk size is invalid");
        }
        upload.parts.push(part);
        upload.received += part.byteLength;
        upload.updatedAt = Date.now();
        return { kind: "chunk", received: upload.received };
    }

    private async commit(request: AlignerCommitRequest): Promise<LocalAlignerPayload> {
        const upload = this.uploads.get(request.uploadId);
        if (!upload) throw new LocalAlignerClientError("UPLOAD_LOST", "Local alignment upload expired");
        if (this.commitLocked) {
            throw new LocalAlignerClientError("ALIGNER_BUSY", "A local alignment task is already being submitted");
        }
        this.commitLocked = true;
        upload.committing = true;
        try {
            if (upload.cancelled) {
                throw new LocalAlignerClientError("UPLOAD_LOST", "Local alignment upload was stopped");
            }
            if (upload.received !== upload.audioSize) {
                throw new LocalAlignerClientError("INVALID_REQUEST", "Local alignment upload is incomplete");
            }

            const form = new FormData();
            form.append("audio", new Blob(upload.parts, { type: upload.audioType }), upload.audioName);
            form.append("transcript_text", upload.transcript);
            form.append("separate", String(upload.separate));
            form.append("bypass_cache", String(upload.bypassCache));
            form.append("preserve_blank_lines", String(upload.preserveBlankLines));
            form.append("word_timing_beta", String(upload.wordTimingBeta));
            form.append("device", upload.device);

            let response = await this.fetchFn(new URL("/api/lrc-editor/jobs", upload.baseUrl), {
                method: "POST",
                body: form,
            });
            if (response.status === 404) {
                response = await this.fetchFn(new URL("/api/jobs", upload.baseUrl), {
                    method: "POST",
                    body: form,
                });
            }
            const job = await readJobResponse(response);
            if (upload.cancelled) {
                await this.cancelJob(upload.baseUrl, job.id).catch(() => undefined);
                throw new LocalAlignerClientError("ALIGNER_FAILED", "Local alignment was stopped");
            }
            return { kind: "job", baseUrl: upload.baseUrl, job };
        } finally {
            this.uploads.delete(request.uploadId);
            this.commitLocked = false;
        }
    }

    private async status(request: AlignerStatusRequest): Promise<LocalAlignerPayload> {
        const response = await this.fetchFn(new URL(`/api/jobs/${request.jobId}`, request.baseUrl), {
            cache: "no-store",
        });
        const job = await readJobResponse(response);
        return { kind: "job", baseUrl: request.baseUrl, job };
    }

    private async result(request: AlignerResultRequest): Promise<LocalAlignerPayload> {
        const output = request.precision === 2 ? "lrc2" : "lrc3";
        const response = await this.fetchFn(
            new URL(`/api/jobs/${request.jobId}/download/${output}`, request.baseUrl),
            { cache: "no-store" },
        );
        if (!response.ok) {
            throw new LocalAlignerClientError("ALIGNER_FAILED", "Aligned LRC is not available");
        }
        return { kind: "result", lrc: await response.text() };
    }

    private async cleanup(request: AlignerCleanupRequest): Promise<LocalAlignerPayload> {
        const response = await this.fetchFn(
            new URL(`/api/jobs/${request.jobId}/cache`, request.baseUrl),
            { method: "DELETE", cache: "no-store" },
        );
        const payload = await response.json() as { reclaimed_bytes?: unknown; detail?: string };
        if (!response.ok || typeof payload.reclaimed_bytes !== "number" || payload.reclaimed_bytes < 0) {
            throw new LocalAlignerClientError(
                "ALIGNER_FAILED",
                payload.detail || "Local alignment task cache could not be deleted",
            );
        }
        return { kind: "cleanup", reclaimedBytes: payload.reclaimed_bytes };
    }

    private async cancel(request: AlignerCancelRequest): Promise<LocalAlignerPayload> {
        if ("uploadId" in request) {
            const upload = this.uploads.get(request.uploadId);
            if (upload) {
                upload.cancelled = true;
                upload.parts.length = 0;
                if (!upload.committing) this.uploads.delete(request.uploadId);
            } else {
                this.cancelledUploads.set(request.uploadId, Date.now());
            }
            return { kind: "cancel", accepted: true };
        }
        await this.cancelJob(request.baseUrl, request.jobId);
        return { kind: "cancel", accepted: true };
    }

    private async cancelJob(baseUrl: string, jobId: string): Promise<void> {
        const token = await this.controlToken(baseUrl);
        const response = await this.fetchFn(
            new URL(`/api/lrc-editor/jobs/${jobId}/cancel`, baseUrl),
            {
                method: "POST",
                cache: "no-store",
                headers: { "X-LRC-Editor-Control": token },
            },
        );
        if (!response.ok) {
            const payload = await response.json().catch(() => ({})) as { detail?: string };
            throw new LocalAlignerClientError("ALIGNER_FAILED", payload.detail || "Alignment could not be stopped");
        }
    }

    private async stopService(_request: AlignerServiceStopRequest): Promise<LocalAlignerPayload> {
        const service = await this.findService();
        const token = await this.controlToken(service.baseUrl);
        const response = await this.fetchFn(new URL("/api/lrc-editor/service/stop", service.baseUrl), {
            method: "POST",
            cache: "no-store",
            headers: { "X-LRC-Editor-Control": token },
        });
        if (!response.ok) {
            const payload = await response.json().catch(() => ({})) as { detail?: string };
            throw new LocalAlignerClientError(
                "ALIGNER_FAILED",
                payload.detail || "Local AI service could not be stopped",
            );
        }
        this.cachedService = undefined;
        return { kind: "service-stop", accepted: true };
    }

    private async clearCache(_request: AlignerCacheClearRequest): Promise<LocalAlignerPayload> {
        const service = await this.findService();
        const token = await this.controlToken(service.baseUrl);
        const response = await this.fetchFn(new URL("/api/lrc-editor/cache", service.baseUrl), {
            method: "DELETE",
            cache: "no-store",
            headers: { "X-LRC-Editor-Control": token },
        });
        const payload = await response.json().catch(() => ({})) as {
            detail?: string;
            reclaimed_bytes?: unknown;
        };
        if (!response.ok || typeof payload.reclaimed_bytes !== "number" || payload.reclaimed_bytes < 0) {
            throw new LocalAlignerClientError(
                "ALIGNER_FAILED",
                payload.detail || "Local AI cache could not be cleared",
            );
        }
        return { kind: "cache-clear", reclaimedBytes: payload.reclaimed_bytes };
    }

    private async controlToken(baseUrl: string): Promise<string> {
        const response = await this.fetchFn(new URL("/api/lrc-editor/capabilities", baseUrl), {
            cache: "no-store",
        });
        if (!response.ok) throw new LocalAlignerClientError("ALIGNER_FAILED", "Companion control is unavailable");
        const payload = await response.json() as { control_token?: unknown };
        if (typeof payload.control_token !== "string" || payload.control_token.length < 32) {
            throw new LocalAlignerClientError("ALIGNER_FAILED", "Companion control response was invalid");
        }
        return payload.control_token;
    }

    private async findService(): Promise<{ baseUrl: string; version: string }> {
        if (this.cachedService) {
            try {
                return await this.checkService(this.cachedService.baseUrl);
            } catch {
                this.cachedService = undefined;
            }
        }
        const preferredBaseUrl = `http://127.0.0.1:${localAlignerPorts[0]}/`;
        try {
            const service = await this.checkService(preferredBaseUrl, 1_500);
            this.cachedService = service;
            return service;
        } catch (preferredError) {
            try {
                const service = await firstSuccessful(
                    localAlignerPorts.slice(1).map((port) => this.checkService(`http://127.0.0.1:${port}/`, 1_200)),
                );
                this.cachedService = service;
                return service;
            } catch {
                const detail = preferredError instanceof Error ? `: ${preferredError.message}` : "";
                throw new LocalAlignerClientError(
                    "ALIGNER_NOT_RUNNING",
                    `Lyrics Forced Aligner is not running${detail}`,
                );
            }
        }
    }

    private async checkService(baseUrl: string, timeoutMs = 800): Promise<{ baseUrl: string; version: string }> {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await this.fetchFn(new URL("/openapi.json", baseUrl), {
                cache: "no-store",
                signal: controller.signal,
            });
            if (!response.ok) throw new Error("Local aligner probe failed");
            const payload = await response.json() as { info?: { title?: string; version?: string } };
            if (payload.info?.title !== "Lyrics Forced Aligner" || typeof payload.info.version !== "string") {
                throw new Error("Unexpected local service");
            }
            return { baseUrl, version: payload.info.version };
        } finally {
            clearTimeout(timeout);
        }
    }

    private async ensureServiceIdle(baseUrl: string): Promise<void> {
        const response = await this.fetchFn(new URL("/api/health", baseUrl), { cache: "no-store" });
        if (!response.ok) throw new LocalAlignerClientError("ALIGNER_FAILED", "Local aligner health check failed");
        const payload = await response.json() as { gpu_queue?: { running?: unknown; queued?: unknown } };
        const running = payload.gpu_queue?.running;
        const queued = payload.gpu_queue?.queued;
        if (typeof running !== "number" || typeof queued !== "number") {
            throw new LocalAlignerClientError("ALIGNER_FAILED", "Local aligner health response was invalid");
        }
        if (running > 0 || queued > 0) {
            throw new LocalAlignerClientError("ALIGNER_BUSY", "Another local alignment task is already running");
        }
    }

    private removeExpiredUploads(): void {
        const cutoff = Date.now() - 2 * 60_000;
        for (const [uploadId, upload] of this.uploads) {
            if (upload.updatedAt < cutoff) this.uploads.delete(uploadId);
        }
        for (const [uploadId, cancelledAt] of this.cancelledUploads) {
            if (cancelledAt < cutoff) this.cancelledUploads.delete(uploadId);
        }
    }
}

const firstSuccessful = <T>(promises: readonly Promise<T>[]): Promise<T> =>
    new Promise((resolve, reject) => {
        if (promises.length === 0) {
            reject(new Error("No local aligner endpoints were provided"));
            return;
        }
        let pending = promises.length;
        for (const promise of promises) {
            promise.then(resolve, (error: unknown) => {
                pending -= 1;
                if (pending === 0) reject(error);
            });
        }
    });

const readJobResponse = async (response: Response): Promise<LocalAlignerJob> => {
    const payload = await response.json() as Partial<LocalAlignerJob> & { detail?: string };
    if (!response.ok) {
        throw new LocalAlignerClientError("ALIGNER_FAILED", payload.detail || "Local alignment request failed");
    }
    if (
        typeof payload.id !== "string" || !/^[a-f0-9]{32}$/i.test(payload.id)
        || !["queued", "running", "complete", "failed"].includes(payload.status || "")
        || typeof payload.stage !== "string" || typeof payload.progress !== "number"
    ) {
        throw new LocalAlignerClientError("ALIGNER_FAILED", "Local aligner returned an invalid job");
    }
    return payload as LocalAlignerJob;
};

const decodeBase64 = (value: string): Uint8Array<ArrayBuffer> => {
    try {
        const binary = atob(value);
        const output = new Uint8Array(new ArrayBuffer(binary.length));
        for (let index = 0; index < binary.length; index += 1) output[index] = binary.charCodeAt(index);
        return output;
    } catch {
        throw new LocalAlignerClientError("INVALID_REQUEST", "Local alignment chunk encoding is invalid");
    }
};

const sanitizeFileName = (value: string): string => {
    const sanitized = Array.from(
        value,
        (character) => character.charCodeAt(0) < 32 || "<>:\"/\\|?*".includes(character) ? "_" : character,
    ).join("");
    return sanitized.replace(/[. ]+$/g, "").slice(0, 255) || "audio.bin";
};
