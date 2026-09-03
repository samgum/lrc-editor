export const huhuApiBaseUrl = "https://huhu.cdgz.top/api/v1";
export const huhuAllowedBrowserOrigin = "https://lrc.sgmy.org";
export const isHuhuBrowserOriginAllowed = (origin: string): boolean => origin === huhuAllowedBrowserOrigin;

export const huhuAlignmentLanguages = ["ja", "en", "ja-en", "zh-hans-cn", "zh-hans-cn-en"] as const;
export type HuhuAlignmentLanguage = typeof huhuAlignmentLanguages[number];

export class HuhuApiError extends Error {
    constructor(
        readonly code:
            | "cancelled"
            | "cors"
            | "denied"
            | "failed"
            | "invalid-key"
            | "invalid-response"
            | "quota",
        message: string,
    ) {
        super(message);
        this.name = HuhuApiError.name;
    }
}

export interface HuhuCapability {
    available: boolean;
    reason?: string;
    cycleRequests?: {
        limit: number | null;
        pending: number;
        remaining: number | null;
        used: number;
    };
}

export interface HuhuAlignmentProgress {
    phase: "connecting" | "uploading" | "queued" | "running" | "downloading" | "stopping" | "complete";
    progress: number;
    detail?: string;
}

export interface HuhuAlignmentOptions {
    apiKey: string;
    audio: Blob;
    audioName: string;
    transcript: string;
    language: HuhuAlignmentLanguage;
    signal?: AbortSignal;
    onProgress?: (progress: HuhuAlignmentProgress) => void;
}

interface HuhuJob {
    id: string;
    status: string;
    progress?: number;
    detail?: string;
    error?: string;
}

export const checkHuhuAlignmentCapability = async (
    apiKey: string,
    signal?: AbortSignal,
): Promise<HuhuCapability> => {
    const response = await request("/capabilities/alignment", apiKey, { signal });
    const body = await readJson(response);
    const permission = asRecord(body.permission);
    const available = permission.available === true;
    const reason = typeof permission.reason === "string" ? permission.reason : undefined;
    const quota = asRecord(body.quota);
    const periods = asRecord(quota.periods);
    const cycle = asRecord(periods.cycle);
    const metrics = asRecord(cycle.metrics);
    const requests = asRecord(metrics.requests);
    return {
        available,
        reason,
        cycleRequests: Object.keys(requests).length === 0
            ? undefined
            : {
                used: finiteNumber(requests.used, 0),
                pending: finiteNumber(requests.pending, 0),
                limit: nullableNumber(requests.limit),
                remaining: nullableNumber(requests.remaining),
            },
    };
};

export const runHuhuAlignment = async (options: HuhuAlignmentOptions): Promise<string> => {
    throwIfCancelled(options.signal);
    options.onProgress?.({ phase: "connecting", progress: 0.01 });
    const capability = await checkHuhuAlignmentCapability(options.apiKey, options.signal);
    if (!capability.available) {
        throw new HuhuApiError("denied", capability.reason || "alignment_not_available");
    }
    if (capability.cycleRequests?.remaining === 0) {
        throw new HuhuApiError("quota", "alignment_quota_exhausted");
    }

    const form = new FormData();
    form.set("audio", options.audio, safeMediaName(options.audioName));
    form.set("lyrics", options.transcript);
    form.set("language", options.language);
    options.onProgress?.({ phase: "uploading", progress: 0.06 });

    let activeJobId: string | undefined;
    try {
        const createResponse = await request("/alignment", options.apiKey, {
            method: "POST",
            body: form,
            signal: options.signal,
        });
        const createBody = await readJson(createResponse);
        let job = parseJob(createBody);
        activeJobId = job.id;
        while (!isComplete(job.status)) {
            throwIfCancelled(options.signal);
            if (isFailed(job.status)) throw new HuhuApiError("failed", job.error || job.detail || job.status);
            if (isCancelled(job.status)) throw new HuhuApiError("cancelled", job.status);
            options.onProgress?.({
                phase: isQueued(job.status) ? "queued" : "running",
                progress: 0.12 + normalizeProgress(job.progress) * 0.78,
                detail: job.detail,
            });
            await cancellableDelay(1_200, options.signal);
            const statusResponse = await request(`/jobs/${encodeURIComponent(job.id)}`, options.apiKey, {
                signal: options.signal,
            });
            job = parseJob(await readJson(statusResponse));
        }
        options.onProgress?.({ phase: "downloading", progress: 0.94, detail: job.detail });
        const resultResponse = await request(`/jobs/${encodeURIComponent(job.id)}/lrc`, options.apiKey, {
            signal: options.signal,
            accept: "text/plain, application/octet-stream",
        });
        const lrc = (await resultResponse.text()).trim();
        if (!lrc) throw new HuhuApiError("invalid-response", "empty_alignment_result");
        options.onProgress?.({ phase: "complete", progress: 1, detail: job.detail });
        return lrc;
    } catch (error) {
        if (!options.signal?.aborted) throw error;
        options.onProgress?.({ phase: "stopping", progress: 0 });
        if (activeJobId) {
            await request(`/jobs/${encodeURIComponent(activeJobId)}/cancel`, options.apiKey, {
                method: "POST",
            }).catch(() => undefined);
        }
        throw new HuhuApiError("cancelled", "alignment_cancelled");
    }
};

const request = async (
    path: string,
    apiKey: string,
    options: {
        accept?: string;
        body?: BodyInit;
        method?: "GET" | "POST";
        signal?: AbortSignal;
    } = {},
): Promise<Response> => {
    throwIfCancelled(options.signal);
    let response: Response;
    try {
        const method = options.method || "GET";
        const fetchOptions: RequestInit = {
            method,
            headers: {
                Accept: options.accept || "application/json",
                Authorization: `Bearer ${apiKey}`,
            },
            cache: "no-store",
            credentials: "omit",
            referrerPolicy: "no-referrer",
            signal: options.signal,
        };
        if (method === "POST" && options.body !== undefined) fetchOptions.body = options.body;
        response = await fetch(`${huhuApiBaseUrl}${path}`, fetchOptions);
    } catch (error) {
        if (options.signal?.aborted) throw new HuhuApiError("cancelled", "request_cancelled");
        throw new HuhuApiError("cors", error instanceof Error ? error.message : "network_error");
    }
    if (response.ok) return response;
    const detail = await readErrorDetail(response);
    if (response.status === 401 || response.status === 403) {
        throw new HuhuApiError("invalid-key", detail);
    }
    if (response.status === 429) throw new HuhuApiError("quota", detail);
    throw new HuhuApiError("failed", detail);
};

const readJson = async (response: Response): Promise<Record<string, unknown>> => {
    try {
        return asRecord(await response.json());
    } catch {
        throw new HuhuApiError("invalid-response", "invalid_json_response");
    }
};

const readErrorDetail = async (response: Response): Promise<string> => {
    try {
        const body = asRecord(await response.json());
        if (typeof body.detail === "string") return body.detail;
        const detail = asRecord(body.detail);
        if (typeof detail.code === "string") return detail.code;
        if (typeof detail.message === "string") return detail.message;
    } catch {
        return `http_${response.status}`;
    }
    return `http_${response.status}`;
};

const parseJob = (body: Record<string, unknown>): HuhuJob => {
    const nested = [body.job, body.item, body.data]
        .map(asRecord)
        .find((candidate) => Object.keys(candidate).length > 0);
    const source = nested || body;
    const id = typeof source.id === "string" ? source.id : "";
    const status = typeof source.status === "string" ? source.status.toLowerCase() : "";
    if (!id || !status) throw new HuhuApiError("invalid-response", "invalid_job_response");
    return {
        id,
        status,
        progress: typeof source.progress === "number" ? source.progress : undefined,
        detail: typeof source.detail === "string" ? source.detail : undefined,
        error: typeof source.error === "string" ? source.error : undefined,
    };
};

const normalizeProgress = (progress?: number): number => {
    if (!Number.isFinite(progress)) return 0;
    const normalized = progress! > 1 ? progress! / 100 : progress!;
    return Math.max(0, Math.min(1, normalized));
};

const isComplete = (status: string): boolean => ["complete", "completed", "success", "succeeded"].includes(status);
const isFailed = (status: string): boolean => ["error", "failed", "failure"].includes(status);
const isCancelled = (status: string): boolean => ["canceled", "cancelled"].includes(status);
const isQueued = (status: string): boolean => ["created", "pending", "queued", "waiting"].includes(status);

const cancellableDelay = (milliseconds: number, signal?: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new HuhuApiError("cancelled", "request_cancelled"));
            return;
        }
        const timeout = setTimeout(finish, milliseconds);
        const onAbort = (): void => {
            clearTimeout(timeout);
            signal?.removeEventListener("abort", onAbort);
            reject(new HuhuApiError("cancelled", "request_cancelled"));
        };
        function finish(): void {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }
        signal?.addEventListener("abort", onAbort, { once: true });
    });

const throwIfCancelled = (signal?: AbortSignal): void => {
    if (signal?.aborted) throw new HuhuApiError("cancelled", "request_cancelled");
};

const safeMediaName = (name: string): string => {
    const forbidden = "\\/:*?\"<>|";
    const normalized = Array.from(name, (character) => {
        const codePoint = character.codePointAt(0) || 0;
        return codePoint < 32 || forbidden.includes(character) ? "_" : character;
    }).join("").slice(0, 180);
    return normalized || "audio.bin";
};

const asRecord = (value: unknown): Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};

const finiteNumber = (value: unknown, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) ? value : fallback;

const nullableNumber = (value: unknown): number | null =>
    value === null ? null : typeof value === "number" && Number.isFinite(value) ? value : null;
