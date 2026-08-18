import { Innertube } from "youtubei.js/cf-worker";
import {
    alignerResponseType,
    isLocalAlignerRequest,
    type LocalAlignerResponse,
} from "../../src/shared/local-aligner-protocol.js";
import {
    type BilibiliExtensionRequest,
    bilibiliExtensionRequestType,
    isBilibiliUrl,
    isNeteaseShortUrl,
    isYouTubeVideoId,
    type MediaExtensionRequest,
    type MediaExtensionResponse,
    mediaExtensionResponseType,
    type NeteaseExtensionRequest,
    neteaseExtensionRequestType,
    type YouTubeExtensionRequest,
    youtubeExtensionRequestType,
} from "../../src/shared/media-extension-protocol.js";
import { LocalAlignerClient, LocalAlignerClientError } from "./local-aligner-client.js";
import { resolveNeteaseShortLink } from "./netease-link.js";

interface YouTubeClientSession {
    client: Innertube;
    poToken: string;
}

let youtubeClientPromise: Promise<YouTubeClientSession> | undefined;

const loadTokenFrameType = "LRC_EDITOR_LOAD_TOKEN_FRAME";
const tokenVideoId = "jNQXAC9IVRw";
const localAligner = new LocalAlignerClient();

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;
    const siteOrigin = sender.url ? getSiteOrigin(sender.url) : null;
    if (!siteOrigin) return false;
    if (isResolveRequest(message)) {
        void resolveAudio(message, siteOrigin).then(sendResponse);
        return true;
    }
    if (isLocalAlignerRequest(message)) {
        void localAligner.handle(message).then(
            (payload) =>
                sendResponse(
                    {
                        type: alignerResponseType,
                        requestId: message.requestId,
                        ok: true,
                        payload,
                    } satisfies LocalAlignerResponse,
                ),
            (error: unknown) => {
                const known = error instanceof LocalAlignerClientError ? error : undefined;
                sendResponse(
                    {
                        type: alignerResponseType,
                        requestId: message.requestId,
                        ok: false,
                        error: known?.code || "ALIGNER_FAILED",
                        message: known?.message,
                    } satisfies LocalAlignerResponse,
                );
            },
        );
        return true;
    }
    return false;
});

const resolveAudio = (request: MediaExtensionRequest, siteOrigin: string): Promise<MediaExtensionResponse> =>
    request.type === youtubeExtensionRequestType
        ? resolveYouTube(request, siteOrigin)
        : request.type === bilibiliExtensionRequestType
        ? resolveBilibili(request)
        : resolveNetease(request);

const resolveYouTube = async (
    request: YouTubeExtensionRequest,
    siteOrigin: string,
): Promise<MediaExtensionResponse> => {
    try {
        youtubeClientPromise ??= createYouTubeClient(siteOrigin);
        const { client, poToken } = await youtubeClientPromise;
        const strategies = [
            { client: "VISIONOS", format: "mp4" },
            { client: "WEB_EMBEDDED", format: "mp4" },
            { client: "WEB", format: "mp4" },
            { client: "MWEB", format: "mp4" },
            { client: "ANDROID_VR", format: "mp4" },
            { client: "TV", format: "mp4" },
            { client: "TV_SIMPLY", format: "mp4" },
            { client: "TV_EMBEDDED", format: "mp4" },
            { client: "IOS", format: "mp4" },
            { client: "YTMUSIC_ANDROID", format: "mp4" },
            { client: "ANDROID", format: "mp4" },
            { client: "ANDROID_VR", format: "any" },
            { client: "IOS", format: "any" },
        ] as const;

        for (const strategy of strategies) {
            try {
                const loadFormat = () =>
                    client.getStreamingData(request.videoId, {
                        ...strategy,
                        type: "audio",
                        quality: "best",
                    });
                const format = await loadFormat();
                if (!format.url) {
                    continue;
                }
                const url = new URL(format.url);
                url.searchParams.set("pot", poToken);
                const mimeType = format.mime_type?.split(";", 1)[0] || "";
                if (url.protocol === "https:" && isGoogleVideoHost(url.hostname) && mimeType.startsWith("audio/")) {
                    const audioData = await downloadMediaAsBase64(url, async () => {
                        const refreshed = await loadFormat();
                        if (!refreshed.url) throw new Error("YouTube media URL refresh failed");
                        const refreshedUrl = new URL(refreshed.url);
                        refreshedUrl.searchParams.set("pot", poToken);
                        if (refreshedUrl.protocol !== "https:" || !isGoogleVideoHost(refreshedUrl.hostname)) {
                            throw new Error("YouTube media URL refresh was invalid");
                        }
                        return refreshedUrl;
                    });
                    return success(request.requestId, "youtube", url.href, mimeType, format.bitrate, audioData);
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

const createYouTubeClient = async (siteOrigin: string): Promise<YouTubeClientSession> => {
    const { poToken, visitorData } = await requestYouTubePlaybackToken(siteOrigin);
    const client = await Innertube.create({
        generate_session_locally: true,
        po_token: poToken,
        retrieve_player: false,
        visitor_data: visitorData,
    });
    return { client, poToken };
};

const requestYouTubePlaybackToken = (siteOrigin: string): Promise<{ poToken: string; visitorData: string }> =>
    new Promise((resolve, reject) => {
        let settled = false;
        const finish = (result?: { poToken: string; visitorData: string }, error?: Error): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            chrome.webRequest.onBeforeRequest.removeListener(onBeforeRequest);
            void chrome.offscreen.closeDocument().catch(() => undefined);
            if (result) resolve(result);
            else reject(error || new Error("YouTube playback token was unavailable"));
        };
        const onBeforeRequest = (
            details: chrome.webRequest.OnBeforeRequestDetails,
        ): chrome.webRequest.BlockingResponse | undefined => {
            if (details.tabId !== -1 || !details.requestBody?.raw) return undefined;
            try {
                const payloadText = details.requestBody.raw
                    .map((part) => part.bytes ? new TextDecoder().decode(part.bytes) : "")
                    .join("");
                const payload = JSON.parse(payloadText) as {
                    videoId?: string;
                    context?: { client?: { visitorData?: string } };
                    serviceIntegrityDimensions?: { poToken?: string };
                };
                const poToken = payload.serviceIntegrityDimensions?.poToken;
                const visitorData = payload.context?.client?.visitorData;
                if (payload.videoId === tokenVideoId && poToken && visitorData) {
                    finish({ poToken, visitorData });
                }
            } catch {
                return undefined;
            }
            return undefined;
        };
        const timeout = setTimeout(() => finish(undefined, new Error("YouTube playback token timed out")), 20_000);
        chrome.webRequest.onBeforeRequest.addListener(
            onBeforeRequest,
            { urls: ["https://www.youtube.com/youtubei/v1/player*"] },
            ["requestBody"],
        );
        void (async () => {
            try {
                if (await chrome.offscreen.hasDocument()) {
                    await chrome.offscreen.closeDocument();
                }
                await chrome.offscreen.createDocument({
                    url: "offscreen.html",
                    reasons: [chrome.offscreen.Reason.AUDIO_PLAYBACK, chrome.offscreen.Reason.DOM_SCRAPING],
                    justification: "Generate a YouTube playback token for the requested media",
                });
                const tokenPageUrl = new URL("/youtube-token.html", siteOrigin);
                tokenPageUrl.searchParams.set("video", tokenVideoId);
                await chrome.runtime.sendMessage({ type: loadTokenFrameType, tokenPageUrl: tokenPageUrl.href });
            } catch (error) {
                finish(undefined, error instanceof Error ? error : new Error(String(error)));
            }
        })();
    });

const getSiteOrigin = (value: string): string | null => {
    try {
        const url = new URL(value);
        if (url.protocol === "https:" && url.hostname === "lrc.sgmy.org") return url.origin;
        if (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1")) {
            return url.origin;
        }
        return null;
    } catch {
        return null;
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

const resolveNetease = async (request: NeteaseExtensionRequest): Promise<MediaExtensionResponse> => {
    try {
        return {
            type: mediaExtensionResponseType,
            requestId: request.requestId,
            ok: true,
            provider: "netease",
            songId: await resolveNeteaseShortLink(request.url),
        };
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
    audioData?: string,
): MediaExtensionResponse => ({
    type: mediaExtensionResponseType,
    requestId,
    ok: true,
    provider,
    audioUrl,
    audioData,
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
        : request.type === bilibiliExtensionRequestType
        ? isBilibiliUrl(request.url)
        : request.type === neteaseExtensionRequestType && isNeteaseShortUrl(request.url);
};

const isGoogleVideoHost = (hostname: string): boolean =>
    hostname === "googlevideo.com" || hostname.endsWith(".googlevideo.com");

const isBilibiliMediaHost = (hostname: string): boolean =>
    hostname === "bilivideo.com" || hostname.endsWith(".bilivideo.com");

const downloadMediaAsBase64 = async (initialUrl: URL, refreshUrl: () => Promise<URL>): Promise<string> => {
    let url = initialUrl;
    let mediaLength = Number.parseInt(url.searchParams.get("clen") || "", 10);
    if (!Number.isSafeInteger(mediaLength) || mediaLength <= 0) {
        const probe = await fetch(url, { headers: { Range: "bytes=0-0" } });
        const total = /\/(\d+)$/.exec(probe.headers.get("Content-Range") || "")?.[1];
        mediaLength = Number.parseInt(total || "", 10);
    }
    if (!Number.isSafeInteger(mediaLength) || mediaLength <= 0 || mediaLength > 64 * 1024 * 1024) {
        throw new Error("Unsupported YouTube audio size");
    }

    const readRange = async (start: number, end: number): Promise<Uint8Array> => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
                const response = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
                if (response.ok) {
                    const contentRange = /^bytes\s+(\d+)-(\d+)\/(?:\d+|\*)$/i.exec(
                        response.headers.get("Content-Range") || "",
                    );
                    if (contentRange && Number.parseInt(contentRange[1], 10) !== start) {
                        throw new Error("YouTube media response started at an unexpected byte");
                    }
                    const data = new Uint8Array(await response.arrayBuffer());
                    if (data.byteLength === 0) throw new Error("YouTube media response was empty");
                    return data;
                }
            } catch {
                if (attempt === 2) throw new Error(`YouTube media request failed at byte ${start}`);
            }
            await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
        }
        throw new Error(`YouTube media request failed at byte ${start}`);
    };

    const firstPart = await readRange(0, Math.min(512 * 1024 - 1, mediaLength - 1));
    const chunkSize = firstPart.byteLength;
    const descriptors: Array<{ end: number; index: number; start: number }> = [];
    for (let start = chunkSize, index = 1; start < mediaLength; start += chunkSize, index += 1) {
        descriptors.push({ start, end: Math.min(start + chunkSize - 1, mediaLength - 1), index });
    }
    const parts: Uint8Array[] = [firstPart];

    for (let batchStart = 0; batchStart < descriptors.length; batchStart += 32) {
        let pending = descriptors.slice(batchStart, batchStart + 32);
        for (let refreshCount = 0; pending.length > 0 && refreshCount <= 8; refreshCount += 1) {
            const results = await Promise.all(pending.map(async (descriptor) => {
                try {
                    return { descriptor, data: await readRange(descriptor.start, descriptor.end) };
                } catch {
                    return { descriptor };
                }
            }));
            pending = [];
            for (const result of results) {
                if (result.data) {
                    const expectedLength = result.descriptor.end - result.descriptor.start + 1;
                    if (result.data.byteLength !== expectedLength) {
                        throw new Error(`YouTube media response length was invalid at byte ${result.descriptor.start}`);
                    }
                    parts[result.descriptor.index] = result.data;
                } else {
                    pending.push(result.descriptor);
                }
            }
            if (pending.length > 0) url = await refreshUrl();
        }
        if (pending.length > 0) {
            throw new Error(`YouTube media request failed at byte ${pending[0].start}`);
        }
    }

    const media = new Uint8Array(mediaLength);
    let writeOffset = 0;
    for (const part of parts) {
        const remaining = mediaLength - writeOffset;
        media.set(part.subarray(0, remaining), writeOffset);
        writeOffset += Math.min(part.byteLength, remaining);
    }

    return encodeBase64(media);
};

const encodeBase64 = (media: Uint8Array): string => {
    let binary = "";
    for (let index = 0; index < media.length; index += 32_768) {
        binary += String.fromCharCode(...media.subarray(index, index + 32_768));
    }
    return btoa(binary);
};

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
