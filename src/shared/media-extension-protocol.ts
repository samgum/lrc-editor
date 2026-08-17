export const youtubeExtensionRequestType = "LRC_EDITOR_RESOLVE_YOUTUBE";
export const bilibiliExtensionRequestType = "LRC_EDITOR_RESOLVE_BILIBILI";
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

export type MediaExtensionRequest = YouTubeExtensionRequest | BilibiliExtensionRequest;

export type MediaExtensionResponse =
    | {
        type: typeof mediaExtensionResponseType;
        requestId: string;
        ok: true;
        provider: "youtube" | "bilibili";
        audioUrl: string;
        mimeType: string;
        bitrate?: number;
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
