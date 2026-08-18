export const alignerStartRequestType = "LRC_EDITOR_ALIGNER_START";
export const alignerChunkRequestType = "LRC_EDITOR_ALIGNER_CHUNK";
export const alignerCommitRequestType = "LRC_EDITOR_ALIGNER_COMMIT";
export const alignerStatusRequestType = "LRC_EDITOR_ALIGNER_STATUS";
export const alignerResultRequestType = "LRC_EDITOR_ALIGNER_RESULT_REQUEST";
export const alignerCleanupRequestType = "LRC_EDITOR_ALIGNER_CLEANUP";
export const alignerCancelRequestType = "LRC_EDITOR_ALIGNER_CANCEL";
export const alignerServiceStopRequestType = "LRC_EDITOR_ALIGNER_SERVICE_STOP";
export const alignerCacheClearRequestType = "LRC_EDITOR_ALIGNER_CACHE_CLEAR";
export const alignerResponseType = "LRC_EDITOR_ALIGNER_RESULT";

export const localAlignerPorts = [8765, ...Array.from({ length: 20 }, (_, index) => 8876 + index)] as const;
export const localAlignerChunkSize = 512 * 1024;
export const localAlignerMaxAudioBytes = 512 * 1024 * 1024;

interface AlignerRequestBase {
    requestId: string;
}

export interface AlignerStartRequest extends AlignerRequestBase {
    type: typeof alignerStartRequestType;
    uploadId: string;
    audioName: string;
    audioType: string;
    audioSize: number;
    transcript: string;
    separate: boolean;
    bypassCache: boolean;
    preserveBlankLines: boolean;
    wordTimingBeta: boolean;
    useGpuAcceleration: boolean;
}

export interface AlignerChunkRequest extends AlignerRequestBase {
    type: typeof alignerChunkRequestType;
    uploadId: string;
    index: number;
    data: string;
}

export interface AlignerCommitRequest extends AlignerRequestBase {
    type: typeof alignerCommitRequestType;
    uploadId: string;
}

export interface AlignerStatusRequest extends AlignerRequestBase {
    type: typeof alignerStatusRequestType;
    baseUrl: string;
    jobId: string;
}

export interface AlignerResultRequest extends AlignerRequestBase {
    type: typeof alignerResultRequestType;
    baseUrl: string;
    jobId: string;
    precision: 2 | 3;
}

export interface AlignerCleanupRequest extends AlignerRequestBase {
    type: typeof alignerCleanupRequestType;
    baseUrl: string;
    jobId: string;
}

export interface AlignerCancelUploadRequest extends AlignerRequestBase {
    type: typeof alignerCancelRequestType;
    uploadId: string;
}

export interface AlignerCancelJobRequest extends AlignerRequestBase {
    type: typeof alignerCancelRequestType;
    baseUrl: string;
    jobId: string;
}

export type AlignerCancelRequest = AlignerCancelUploadRequest | AlignerCancelJobRequest;

export interface AlignerServiceStopRequest extends AlignerRequestBase {
    type: typeof alignerServiceStopRequestType;
}

export interface AlignerCacheClearRequest extends AlignerRequestBase {
    type: typeof alignerCacheClearRequestType;
}

export type LocalAlignerRequest =
    | AlignerStartRequest
    | AlignerChunkRequest
    | AlignerCommitRequest
    | AlignerStatusRequest
    | AlignerResultRequest
    | AlignerCleanupRequest
    | AlignerCancelRequest
    | AlignerServiceStopRequest
    | AlignerCacheClearRequest;

export interface LocalAlignerJob {
    id: string;
    status: "queued" | "running" | "complete" | "failed";
    stage: string;
    progress: number;
    detail?: string;
    error?: string | null;
    downloads?: Record<string, string>;
    summary?: Record<string, unknown>;
}

export type LocalAlignerPayload =
    | { kind: "start"; uploadId: string; baseUrl: string; chunkSize: number; serviceVersion: string }
    | { kind: "chunk"; received: number }
    | { kind: "job"; baseUrl: string; job: LocalAlignerJob }
    | { kind: "result"; lrc: string }
    | { kind: "cleanup"; reclaimedBytes: number }
    | { kind: "cancel"; accepted: true }
    | { kind: "service-stop"; accepted: true }
    | { kind: "cache-clear"; reclaimedBytes: number };

export type LocalAlignerResponse =
    | {
        type: typeof alignerResponseType;
        requestId: string;
        ok: true;
        payload: LocalAlignerPayload;
    }
    | {
        type: typeof alignerResponseType;
        requestId: string;
        ok: false;
        error: "ALIGNER_NOT_RUNNING" | "ALIGNER_BUSY" | "INVALID_REQUEST" | "UPLOAD_LOST" | "ALIGNER_FAILED";
        message?: string;
    };

export const isLocalAlignerRequest = (value: unknown): value is LocalAlignerRequest => {
    if (!isRecord(value) || typeof value.requestId !== "string" || value.requestId.length < 8) return false;
    switch (value.type) {
        case alignerStartRequestType:
            return isUploadId(value.uploadId)
                && typeof value.audioName === "string" && value.audioName.length > 0 && value.audioName.length <= 255
                && typeof value.audioType === "string" && value.audioType.length <= 100
                && Number.isSafeInteger(value.audioSize) && Number(value.audioSize) > 0
                && Number(value.audioSize) <= localAlignerMaxAudioBytes
                && typeof value.transcript === "string" && value.transcript.length > 0
                && value.transcript.length <= 4 * 1024 * 1024
                && typeof value.separate === "boolean" && typeof value.bypassCache === "boolean"
                && typeof value.preserveBlankLines === "boolean" && typeof value.wordTimingBeta === "boolean"
                && typeof value.useGpuAcceleration === "boolean";
        case alignerChunkRequestType:
            return isUploadId(value.uploadId) && Number.isSafeInteger(value.index) && Number(value.index) >= 0
                && typeof value.data === "string" && value.data.length > 0
                && value.data.length <= Math.ceil(localAlignerChunkSize / 3) * 4 + 8
                && /^[A-Za-z0-9+/]+={0,2}$/.test(value.data);
        case alignerCommitRequestType:
            return isUploadId(value.uploadId);
        case alignerStatusRequestType:
            return isLocalAlignerBaseUrl(value.baseUrl) && isJobId(value.jobId);
        case alignerResultRequestType:
            return isLocalAlignerBaseUrl(value.baseUrl) && isJobId(value.jobId)
                && (value.precision === 2 || value.precision === 3);
        case alignerCleanupRequestType:
            return isLocalAlignerBaseUrl(value.baseUrl) && isJobId(value.jobId);
        case alignerCancelRequestType:
            return isUploadId(value.uploadId)
                || (isLocalAlignerBaseUrl(value.baseUrl) && isJobId(value.jobId));
        case alignerServiceStopRequestType:
        case alignerCacheClearRequestType:
            return true;
        default:
            return false;
    }
};

export const isLocalAlignerBaseUrl = (value: unknown): value is string => {
    if (typeof value !== "string") return false;
    try {
        const url = new URL(value);
        return url.protocol === "http:" && url.hostname === "127.0.0.1" && url.pathname === "/"
            && localAlignerPorts.includes(Number(url.port || 80) as typeof localAlignerPorts[number]);
    } catch {
        return false;
    }
};

const isUploadId = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9-]{36}$/i.test(value);

const isJobId = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{32}$/i.test(value);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
