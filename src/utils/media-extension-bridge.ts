import {
    bilibiliExtensionRequestType,
    isBilibiliUrl,
    isYouTubeVideoId,
    mediaExtensionAckType,
    type MediaExtensionRequest,
    type MediaExtensionResponse,
    mediaExtensionResponseType,
    type YouTubeExtensionRequest,
    youtubeExtensionRequestType,
} from "../shared/media-extension-protocol.js";

export class MediaExtensionError extends Error {
    constructor(readonly code: "missing" | "outdated" | "failed", message: string) {
        super(message);
        this.name = MediaExtensionError.name;
    }
}

const minimumMediaExtensionVersion = [0, 3, 0] as const;

export interface ResolvedExtensionAudio {
    url: string;
    mimeType: string;
    bitrate?: number;
}

export const requestYouTubeAudio = (videoId: string, timeoutMs = 45_000): Promise<ResolvedExtensionAudio> => {
    if (!isYouTubeVideoId(videoId)) {
        return Promise.reject(new MediaExtensionError("failed", "Invalid YouTube video id"));
    }
    const request: YouTubeExtensionRequest = {
        type: youtubeExtensionRequestType,
        requestId: crypto.randomUUID(),
        videoId,
    };
    return requestExtensionAudio(request, "youtube", timeoutMs);
};

export const requestBilibiliAudio = (url: string, timeoutMs = 20_000): Promise<ResolvedExtensionAudio> => {
    if (!isBilibiliUrl(url)) {
        return Promise.reject(new MediaExtensionError("failed", "Invalid Bilibili video URL"));
    }
    return requestExtensionAudio(
        { type: bilibiliExtensionRequestType, requestId: crypto.randomUUID(), url },
        "bilibili",
        timeoutMs,
    );
};

const requestExtensionAudio = (
    request: MediaExtensionRequest,
    provider: "youtube" | "bilibili",
    timeoutMs: number,
): Promise<ResolvedExtensionAudio> =>
    new Promise((resolve, reject) => {
        let responseTimeout = 0;
        const extensionTimeout = window.setTimeout(() => {
            window.removeEventListener("message", onMessage);
            reject(new MediaExtensionError("missing", "Media companion extension did not respond"));
        }, 1_500);

        const finish = (): void => {
            window.clearTimeout(extensionTimeout);
            window.clearTimeout(responseTimeout);
            window.removeEventListener("message", onMessage);
        };

        const onMessage = (event: MessageEvent<unknown>): void => {
            if (event.source !== window || event.origin !== location.origin) {
                return;
            }
            if (isExtensionAck(event.data, request.requestId)) {
                window.clearTimeout(extensionTimeout);
                if (!isSupportedExtensionVersion(event.data.version)) {
                    finish();
                    reject(new MediaExtensionError("outdated", "Media companion extension is outdated"));
                    return;
                }
                responseTimeout = window.setTimeout(() => {
                    finish();
                    reject(new MediaExtensionError("failed", "Media resolution timed out"));
                }, timeoutMs);
                return;
            }
            if (!isExtensionResponse(event.data, request.requestId)) {
                return;
            }

            finish();
            if (!event.data.ok) {
                reject(new MediaExtensionError("failed", event.data.error));
                return;
            }

            try {
                const url = new URL(event.data.audioUrl);
                if (
                    event.data.provider !== provider || url.protocol !== "https:"
                    || !event.data.mimeType.startsWith("audio/") || !isProviderMediaHost(provider, url.hostname)
                ) {
                    throw new Error("Unexpected extension response");
                }
                resolve({ url: url.href, mimeType: event.data.mimeType, bitrate: event.data.bitrate });
            } catch {
                reject(new MediaExtensionError("failed", "Invalid media response"));
            }
        };

        window.addEventListener("message", onMessage);
        window.postMessage(request, location.origin);
    });

const isExtensionAck = (
    value: unknown,
    requestId: string,
): value is { type: typeof mediaExtensionAckType; requestId: string; version?: string } => {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const ack = value as Record<string, unknown>;
    return ack.type === mediaExtensionAckType && ack.requestId === requestId;
};

const isSupportedExtensionVersion = (version: string | undefined): boolean => {
    if (!version) return false;
    const current = version.split(".").map((part) => Number.parseInt(part, 10));
    for (const [index, minimum] of minimumMediaExtensionVersion.entries()) {
        const value = current[index] || 0;
        if (value > minimum) return true;
        if (value < minimum) return false;
    }
    return true;
};

const isExtensionResponse = (value: unknown, requestId: string): value is MediaExtensionResponse => {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const response = value as Partial<MediaExtensionResponse>;
    return response.type === mediaExtensionResponseType && response.requestId === requestId
        && typeof response.ok === "boolean";
};

const isProviderMediaHost = (provider: "youtube" | "bilibili", hostname: string): boolean => {
    if (provider === "youtube") {
        return hostname === "googlevideo.com" || hostname.endsWith(".googlevideo.com");
    }
    return hostname === "bilivideo.com" || hostname.endsWith(".bilivideo.com");
};
