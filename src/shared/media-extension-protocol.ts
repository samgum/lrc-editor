export const youtubeExtensionRequestType = "LRC_EDITOR_RESOLVE_YOUTUBE";
export const bilibiliExtensionRequestType = "LRC_EDITOR_RESOLVE_BILIBILI";
export const neteaseExtensionRequestType = "LRC_EDITOR_RESOLVE_NETEASE";
export const mediaExtensionAckType = "LRC_EDITOR_MEDIA_ACK";
export const mediaExtensionResponseType = "LRC_EDITOR_MEDIA_RESULT";

export interface YouTubeExtensionRequest {
    type: typeof youtubeExtensionRequestType;
    requestId: string;
    videoId: string;
}

export interface BilibiliExtensionRequest {
    type: typeof bilibiliExtensionRequestType;
    requestId: string;
    url: string;
}

export interface NeteaseExtensionRequest {
    type: typeof neteaseExtensionRequestType;
    requestId: string;
    url?: string;
    songId?: string;
}

export type MediaExtensionRequest = YouTubeExtensionRequest | BilibiliExtensionRequest | NeteaseExtensionRequest;

export type MediaExtensionResponse =
    | {
        type: typeof mediaExtensionResponseType;
        requestId: string;
        ok: true;
        provider: "youtube" | "bilibili";
        audioUrl: string;
        audioData?: string;
        mimeType: string;
        bitrate?: number;
    }
    | {
        type: typeof mediaExtensionResponseType;
        requestId: string;
        ok: true;
        provider: "netease";
        songId: string;
        audioUrl: string;
        mimeType: string;
    }
    | {
        type: typeof mediaExtensionResponseType;
        requestId: string;
        ok: false;
        error: "INVALID_LINK" | "INVALID_VIDEO" | "NOT_PLAYABLE" | "RESOLVE_FAILED";
    };

export const isYouTubeVideoId = (value: unknown): value is string =>
    typeof value === "string" && /^[A-Za-z0-9_-]{11}$/.test(value);

export const isBilibiliUrl = (value: unknown): value is string => {
    if (typeof value !== "string") {
        return false;
    }
    try {
        const url = new URL(value);
        const host = url.hostname.toLowerCase();
        if (host === "b23.tv") {
            return url.pathname.length > 1;
        }
        if (host !== "bilibili.com" && !host.endsWith(".bilibili.com")) {
            return false;
        }
        return /^\/video\/(?:BV[A-Za-z0-9]+|av\d+)/i.test(url.pathname);
    } catch {
        return false;
    }
};

export const isNeteaseShortUrl = (value: unknown): value is string => {
    if (typeof value !== "string") return false;
    if (!/^https:\/\/163cn\.tv\/[A-Za-z0-9_-]{3,64}\/?(?:[?#].*)?$/i.test(value)) return false;
    try {
        const url = new URL(value);
        return url.protocol === "https:" && url.hostname.toLowerCase() === "163cn.tv" && url.port === ""
            && /^\/[A-Za-z0-9_-]{3,64}\/?$/.test(url.pathname)
            && url.username === "" && url.password === "";
    } catch {
        return false;
    }
};

export const extractNeteaseSongId = (value: URL | string): string | null => {
    try {
        const url = typeof value === "string" ? new URL(value) : value;
        const host = url.hostname.toLowerCase();
        if (host !== "music.163.com" && !host.endsWith(".music.163.com")) return null;
        const candidate = url.searchParams.get("id") || /\b(\d{4,})\b/.exec(`${url.pathname}${url.hash}`)?.[1];
        return candidate && /^\d{4,}$/.test(candidate) ? candidate : null;
    } catch {
        return null;
    }
};
