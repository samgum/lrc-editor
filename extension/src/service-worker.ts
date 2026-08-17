import { Innertube } from "youtubei.js/web";
import {
    type BilibiliExtensionRequest,
    bilibiliExtensionRequestType,
    isBilibiliUrl,
    isYouTubeVideoId,
    type MediaExtensionRequest,
    type MediaExtensionResponse,
    mediaExtensionResponseType,
    type YouTubeExtensionRequest,
    youtubeExtensionRequestType,
} from "../../src/shared/media-extension-protocol.js";

let youtubeClientPromise: Promise<Innertube> | undefined;

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || !isResolveRequest(message)) {
        return false;
    }

    void resolveAudio(message).then(sendResponse);
    return true;
});

const resolveAudio = (request: MediaExtensionRequest): Promise<MediaExtensionResponse> =>
    request.type === youtubeExtensionRequestType ? resolveYouTube(request) : resolveBilibili(request);

const resolveYouTube = async (request: YouTubeExtensionRequest): Promise<MediaExtensionResponse> => {
    try {
        youtubeClientPromise ??= Innertube.create({
            generate_session_locally: true,
            retrieve_player: false,
        });
        const client = await youtubeClientPromise;
        const strategies = [
            { client: "IOS", format: "mp4" },
            { client: "YTMUSIC_ANDROID", format: "mp4" },
            { client: "ANDROID", format: "mp4" },
            { client: "IOS", format: "any" },
        ] as const;

        for (const strategy of strategies) {
            try {
                const format = await client.getStreamingData(request.videoId, {
                    ...strategy,
                    type: "audio",
                    quality: "best",
                });
                if (!format.url) {
                    continue;
                }
                const url = new URL(format.url);
                const mimeType = format.mime_type?.split(";", 1)[0] || "";
                if (url.protocol === "https:" && isGoogleVideoHost(url.hostname) && mimeType.startsWith("audio/")) {
                    return success(request.requestId, "youtube", url.href, mimeType, format.bitrate);
                }
            } catch {
                continue;
            }
        }
        youtubeClientPromise = undefined;
        return failure(request.requestId, "NOT_PLAYABLE");
    } catch {
        youtubeClientPromise = undefined;
        return failure(request.requestId, "RESOLVE_FAILED");
    }
};

const resolveBilibili = async (request: BilibiliExtensionRequest): Promise<MediaExtensionResponse> => {
    try {
        const videoUrl = await expandBilibiliUrl(request.url);
        const identity = getBilibiliIdentity(videoUrl);
        if (identity === null) {
            return failure(request.requestId, "INVALID_LINK");
        }

        const viewUrl = new URL("https://api.bilibili.com/x/web-interface/view");
        viewUrl.searchParams.set(identity.kind, identity.value);
        const view = await fetchBilibiliJson<BilibiliView>(viewUrl);
        const requestedPage = Math.max(0, Number.parseInt(videoUrl.searchParams.get("p") || "1", 10) - 1);
        const cid = view.pages?.[requestedPage]?.cid || view.cid || view.pages?.[0]?.cid;
        if (!cid) {
            return failure(request.requestId, "NOT_PLAYABLE");
        }

        const playUrl = new URL("https://api.bilibili.com/x/player/playurl");
        playUrl.searchParams.set(identity.kind, identity.value);
        playUrl.searchParams.set("cid", cid.toString());
        playUrl.searchParams.set("fnval", "16");
        playUrl.searchParams.set("fnver", "0");
        playUrl.searchParams.set("fourk", "1");
        const play = await fetchBilibiliJson<BilibiliPlayInfo>(playUrl);
        const formats = [...play.dash?.audio || []].sort((left, right) =>
            (right.bandwidth || 0) - (left.bandwidth || 0)
        );
        for (const format of formats) {
            const candidates = [format.baseUrl, format.base_url, ...format.backupUrl || [], ...format.backup_url || []]
                .filter((url): url is string => typeof url === "string");
            const mediaUrl = candidates.map((url) => new URL(url)).find((url) =>
                url.protocol === "https:" && isBilibiliMediaHost(url.hostname)
            );
            if (mediaUrl) {
                const mimeType = format.mimeType || format.mime_type || "audio/mp4";
                return success(request.requestId, "bilibili", mediaUrl.href, mimeType, format.bandwidth);
            }
        }
        return failure(request.requestId, "NOT_PLAYABLE");
    } catch {
        return failure(request.requestId, "RESOLVE_FAILED");
    }
};

const expandBilibiliUrl = async (value: string): Promise<URL> => {
    const url = new URL(value);
    if (url.hostname.toLowerCase() !== "b23.tv") {
        return url;
    }
    const response = await fetch(url, { method: "HEAD", redirect: "follow", credentials: "omit" });
    if (!response.ok) {
        throw new Error("Bilibili short link could not be expanded");
    }
    return new URL(response.url);
};

const getBilibiliIdentity = (url: URL): { kind: "aid" | "bvid"; value: string } | null => {
    const match = /^\/video\/(BV[A-Za-z0-9]+|av(\d+))/i.exec(url.pathname);
    if (!match) {
        return null;
    }
    return match[2] ? { kind: "aid", value: match[2] } : { kind: "bvid", value: match[1] };
};

const fetchBilibiliJson = async <T>(url: URL): Promise<T> => {
    const response = await fetch(url, {
        credentials: "omit",
        headers: { Accept: "application/json", Referer: "https://www.bilibili.com/" },
    });
    if (!response.ok) {
        throw new Error("Bilibili API request failed");
    }
    const payload = await response.json() as BilibiliResponse<T>;
    if (payload.code !== 0 || !payload.data) {
        throw new Error(payload.message || "Bilibili API returned an error");
    }
    return payload.data;
};

const success = (
    requestId: string,
    provider: "youtube" | "bilibili",
    audioUrl: string,
    mimeType: string,
    bitrate?: number,
): MediaExtensionResponse => ({
    type: mediaExtensionResponseType,
    requestId,
    ok: true,
    provider,
    audioUrl,
    mimeType,
    bitrate,
});

const failure = (
    requestId: string,
    error: "INVALID_LINK" | "INVALID_VIDEO" | "NOT_PLAYABLE" | "RESOLVE_FAILED",
): MediaExtensionResponse => ({
    type: mediaExtensionResponseType,
    requestId,
    ok: false,
    error,
});

const isResolveRequest = (value: unknown): value is MediaExtensionRequest => {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const request = value as Record<string, unknown>;
    if (typeof request.requestId !== "string") {
        return false;
    }
    return request.type === youtubeExtensionRequestType
        ? isYouTubeVideoId(request.videoId)
        : request.type === bilibiliExtensionRequestType && isBilibiliUrl(request.url);
};

const isGoogleVideoHost = (hostname: string): boolean =>
    hostname === "googlevideo.com" || hostname.endsWith(".googlevideo.com");

const isBilibiliMediaHost = (hostname: string): boolean =>
    hostname === "bilivideo.com" || hostname.endsWith(".bilivideo.com");

interface BilibiliResponse<T> {
    code: number;
    message?: string;
    data?: T;
}

interface BilibiliView {
    cid?: number;
    pages?: Array<{ cid?: number }>;
}

interface BilibiliPlayInfo {
    dash?: {
        audio?: BilibiliAudioFormat[];
    };
}

interface BilibiliAudioFormat {
    bandwidth?: number;
    baseUrl?: string;
    base_url?: string;
    backupUrl?: string[];
    backup_url?: string[];
    mimeType?: string;
    mime_type?: string;
}
