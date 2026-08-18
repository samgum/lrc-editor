export const youtubeExtensionRequestType = "LRC_EDITOR_RESOLVE_YOUTUBE";
export const bilibiliExtensionRequestType = "LRC_EDITOR_RESOLVE_BILIBILI";
export const neteaseExtensionRequestType = "LRC_EDITOR_RESOLVE_NETEASE";
export const qqMusicExtensionRequestType = "LRC_EDITOR_RESOLVE_QQMUSIC";
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

export interface QQMusicExtensionRequest {
    type: typeof qqMusicExtensionRequestType;
    requestId: string;
    url?: string;
    songMid?: string;
}

export type MediaExtensionRequest =
    | YouTubeExtensionRequest
    | BilibiliExtensionRequest
    | NeteaseExtensionRequest
    | QQMusicExtensionRequest;

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
        ok: true;
        provider: "qqmusic";
        songMid: string;
        audioUrl: string;
        mimeType: string;
        duration: number;
    }
    | {
        type: typeof mediaExtensionResponseType;
        requestId: string;
        ok: false;
        error: "INVALID_LINK" | "INVALID_VIDEO" | "NOT_PLAYABLE" | "RESOLVE_FAILED";
        message?: string;
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

export const isQQMusicSongMid = (value: unknown): value is string =>
    typeof value === "string" && /^[A-Za-z0-9]{14}$/.test(value);

export const isQQMusicShortUrl = (value: unknown): value is string => {
    if (typeof value !== "string") return false;
    try {
        const url = new URL(value);
        return url.protocol === "https:" && url.hostname.toLowerCase() === "c6.y.qq.com" && url.port === ""
            && url.pathname === "/base/fcgi-bin/u" && /^[A-Za-z0-9_-]{6,64}$/.test(url.searchParams.get("__") || "")
            && url.username === "" && url.password === "";
    } catch {
        return false;
    }
};

export const extractQQMusicSongMid = (value: URL | string): string | null => {
    try {
        const url = typeof value === "string" ? new URL(value) : value;
        const host = url.hostname.toLowerCase();
        let candidate: string | null = null;
        if (host === "y.qq.com") {
            candidate = /^\/n\/ryqq(?:_v2)?\/songDetail\/([A-Za-z0-9]{14})\/?$/i.exec(url.pathname)?.[1]
                || null;
        } else if (host === "i.y.qq.com" && url.pathname === "/v8/playsong.html") {
            candidate = url.searchParams.get("songmid");
        } else if (host === "i2.y.qq.com" && url.pathname === "/n3/other/pages/playsong/index.html") {
            candidate = url.searchParams.get("songmid");
        }
        return isQQMusicSongMid(candidate) ? candidate : null;
    } catch {
        return null;
    }
};

export const isQQMusicUrl = (value: unknown): value is string =>
    typeof value === "string" && (isQQMusicShortUrl(value) || extractQQMusicSongMid(value) !== null);
