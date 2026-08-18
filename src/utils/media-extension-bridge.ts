import {
    bilibiliExtensionRequestType,
    isBilibiliUrl,
    isNeteaseShortUrl,
    isQQMusicSongMid,
    isQQMusicUrl,
    isYouTubeVideoId,
    mediaExtensionAckType,
    type MediaExtensionRequest,
    type MediaExtensionResponse,
    mediaExtensionResponseType,
    type NeteaseExtensionRequest,
    neteaseExtensionRequestType,
    type QQMusicExtensionRequest,
    qqMusicExtensionRequestType,
    type YouTubeExtensionRequest,
    youtubeExtensionRequestType,
} from "../shared/media-extension-protocol.js";

export class MediaExtensionError extends Error {
    constructor(
        readonly code: "missing" | "outdated" | "failed",
        message: string,
        readonly reason?: MediaExtensionFailure,
    ) {
        super(message);
        this.name = MediaExtensionError.name;
    }
}

type MediaExtensionFailure = Extract<MediaExtensionResponse, { ok: false }>["error"];

const minimumMediaExtensionVersion = [0, 3, 1] as const;

export interface ResolvedExtensionAudio {
    data?: string;
    url: string;
    mimeType: string;
    bitrate?: number;
}

export interface ResolvedNeteaseAudio extends ResolvedExtensionAudio {
    songId: string;
}

export interface ResolvedQQMusicAudio extends ResolvedExtensionAudio {
    duration: number;
    songMid: string;
}

export const requestYouTubeAudio = (videoId: string, timeoutMs = 90_000): Promise<ResolvedExtensionAudio> => {
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

export const requestNeteaseAudio = (
    input: { songId: string } | { url: string },
    timeoutMs = 20_000,
): Promise<ResolvedNeteaseAudio> => {
    if ("url" in input ? !isNeteaseShortUrl(input.url) : !/^\d{4,}$/.test(input.songId)) {
        return Promise.reject(new MediaExtensionError("failed", "Invalid NetEase media request"));
    }
    const request: NeteaseExtensionRequest = {
        type: neteaseExtensionRequestType,
        requestId: crypto.randomUUID(),
        ...input,
    };
    return requestExtension(request, timeoutMs).then((response) => {
        if (!response.ok) throw new MediaExtensionError("failed", response.error, response.error);
        if (
            response.provider !== "netease" || !/^\d{4,}$/.test(response.songId)
            || !response.mimeType.startsWith("audio/")
        ) {
            throw new MediaExtensionError("failed", "Invalid NetEase link response");
        }
        const url = new URL(response.audioUrl);
        if (url.protocol !== "https:" || !isProviderMediaHost("netease", url.hostname)) {
            throw new MediaExtensionError("failed", "Invalid NetEase audio response");
        }
        return {
            songId: response.songId,
            url: url.href,
            mimeType: response.mimeType,
        };
    });
};

export const requestQQMusicAudio = (
    input: { songMid: string } | { url: string },
    timeoutMs = 20_000,
): Promise<ResolvedQQMusicAudio> => {
    if ("url" in input ? !isQQMusicUrl(input.url) : !isQQMusicSongMid(input.songMid)) {
        return Promise.reject(new MediaExtensionError("failed", "Invalid QQ Music request"));
    }
    const request: QQMusicExtensionRequest = {
        type: qqMusicExtensionRequestType,
        requestId: crypto.randomUUID(),
        ...input,
    };
    return requestExtension(request, timeoutMs).then((response) => {
        if (!response.ok) throw new MediaExtensionError("failed", response.error, response.error);
        if (
            response.provider !== "qqmusic" || !isQQMusicSongMid(response.songMid)
            || !response.mimeType.startsWith("audio/") || !Number.isFinite(response.duration) || response.duration <= 0
        ) {
            throw new MediaExtensionError("failed", "Invalid QQ Music response");
        }
        const url = new URL(response.audioUrl);
        if (url.protocol !== "https:" || !isProviderMediaHost("qqmusic", url.hostname)) {
            throw new MediaExtensionError("failed", "Invalid QQ Music audio response");
        }
        return {
            duration: response.duration,
            songMid: response.songMid,
            url: url.href,
            mimeType: response.mimeType,
        };
    });
};

const requestExtensionAudio = (
    request: MediaExtensionRequest,
    provider: "youtube" | "bilibili",
    timeoutMs: number,
): Promise<ResolvedExtensionAudio> =>
    requestExtension(request, timeoutMs).then((response) => {
        if (!response.ok) throw new MediaExtensionError("failed", response.error, response.error);
        if (response.provider === "netease" || response.provider === "qqmusic") {
            throw new MediaExtensionError("failed", "Unexpected extension response");
        }
        try {
            const url = new URL(response.audioUrl);
            if (
                response.provider !== provider || url.protocol !== "https:"
                || !response.mimeType.startsWith("audio/") || !isProviderMediaHost(provider, url.hostname)
            ) {
                throw new Error("Unexpected extension response");
            }
            return {
                url: url.href,
                data: response.audioData,
                mimeType: response.mimeType,
                bitrate: response.bitrate,
            };
        } catch {
            throw new MediaExtensionError("failed", "Invalid media response");
        }
    });

const requestExtension = (
    request: MediaExtensionRequest,
    timeoutMs: number,
): Promise<MediaExtensionResponse> =>
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
            resolve(event.data);
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

const isProviderMediaHost = (
    provider: "youtube" | "bilibili" | "netease" | "qqmusic",
    hostname: string,
): boolean => {
    if (provider === "youtube") {
        return hostname === "googlevideo.com" || hostname.endsWith(".googlevideo.com");
    }
    if (provider === "bilibili") {
        return hostname === "bilivideo.com" || hostname.endsWith(".bilivideo.com");
    }
    if (provider === "qqmusic") return hostname === "aqqmusic.tc.qq.com";
    return hostname === "music.126.net" || hostname.endsWith(".music.126.net");
};
