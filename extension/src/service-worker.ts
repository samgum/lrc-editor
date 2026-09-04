import { Innertube } from "youtubei.js/cf-worker";
import {
    alignerResponseType,
    isLocalAlignerRequest,
    type LocalAlignerResponse,
} from "../../src/shared/local-aligner-protocol.js";
import {
    type BilibiliExtensionRequest,
    bilibiliExtensionRequestType,
    extractQQMusicSongMid,
    isBilibiliUrl,
    isNeteaseShortUrl,
    isQQMusicSongMid,
    isQQMusicUrl,
    isYouTubeVideoId,
    type MediaExtensionRequest,
    type MediaExtensionResponse,
    mediaExtensionResponseType,
    type NeteaseExtensionRequest,
    neteaseExtensionRequestType,
    type QQMusicExtensionRequest,
    qqMusicExtensionRequestType,
    type YouTubeExtensionRequest,
    youtubeExtensionRequestType,
} from "../../src/shared/media-extension-protocol.js";
import { LocalAlignerClient, LocalAlignerClientError } from "./local-aligner-client.js";
import { resolveNeteaseAudioUrl, resolveNeteaseShortLink } from "./netease-link.js";
import { parseQQMusicPlaybackPage, QQMusicNotPlayableError } from "./qqmusic-link.js";
import {
    createYouTubeFetch,
    decodeYouTubeRequestBody,
    readYouTubePlaybackContext,
    youtubeAudioClients,
    youtubeClientRevision,
    type YouTubePlaybackContext,
    youtubePlayerToken,
} from "./youtube-client.js";

interface YouTubeClientSession {
    client: Innertube;
    playbackContext: YouTubePlaybackContext | null;
}

let mediaHeaderModePromise: Promise<"dnr" | "legacy"> | undefined;
let legacyHeaderRulesInstalled = false;
let mediaFrameQueue: Promise<void> = Promise.resolve();
let qqMusicFramePending: {
    expectedSongMid: string | null;
    resolve: (value: { html: string; songMid: string }) => void;
} | undefined;
type QQMusicResolvedAudio = ReturnType<typeof parseQQMusicPlaybackPage> & { songMid: string };
const qqMusicResolutionPromises = new Map<string, Promise<QQMusicResolvedAudio>>();

const loadTokenFrameType = "LRC_EDITOR_LOAD_TOKEN_FRAME";
const loadQQMusicFrameType = "LRC_EDITOR_LOAD_QQMUSIC_FRAME";
const removeMediaFrameType = "LRC_EDITOR_REMOVE_MEDIA_FRAME";
const qqMusicFrameResultType = "LRC_EDITOR_QQMUSIC_FRAME_RESULT";
const qqMusicHeaderRuleId = 90_046;
const qqMusicMobileUserAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 "
    + "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const localAligner = new LocalAlignerClient();
const firefoxAndroid = import.meta.env.firefoxAndroid === true;

type MediaFrameRequest =
    | { type: typeof loadTokenFrameType; tokenPageUrl: string }
    | { type: typeof loadQQMusicFrameType; frameUrl: string };

type MediaFrameHost = { kind: "offscreen" } | { kind: "tab"; tabId: number };

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (isQQMusicFrameResult(message) && isQQMusicFrameSender(sender, message.songMid)) {
        const pending = qqMusicFramePending;
        if (pending && (!pending.expectedSongMid || pending.expectedSongMid === message.songMid)) {
            pending.resolve({ html: message.html, songMid: message.songMid });
        }
        return false;
    }
    const siteBaseUrl = sender.url ? getSiteBaseUrl(sender.url) : null;
    if (!siteBaseUrl) return false;
    if (isResolveRequest(message)) {
        void resolveAudio(message, siteBaseUrl, sender.tab?.id).then(sendResponse);
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

const resolveAudio = (
    request: MediaExtensionRequest,
    siteBaseUrl: string,
    tabId?: number,
): Promise<MediaExtensionResponse> =>
    request.type === youtubeExtensionRequestType
        ? resolveYouTube(request, siteBaseUrl, tabId)
        : request.type === bilibiliExtensionRequestType
        ? resolveBilibili(request)
        : request.type === neteaseExtensionRequestType
        ? resolveNetease(request)
        : resolveQQMusic(request, tabId);

const resolveYouTube = async (
    request: YouTubeExtensionRequest,
    siteBaseUrl: string,
    tabId?: number,
): Promise<MediaExtensionResponse> => {
    try {
        const { client, playbackContext } = await createYouTubeClient(request.videoId, siteBaseUrl, tabId);
        for (const clientName of youtubeAudioClients) {
            try {
                const options = {
                    client: clientName,
                    po_token: youtubePlayerToken(playbackContext, request.videoId, clientName),
                };
                const info = await client.getBasicInfo(request.videoId, options);
                const triedItags = new Set<number>();
                for (const container of ["mp4", "any"] as const) {
                    try {
                        const format = info.chooseFormat({ type: "audio", quality: "best", format: container });
                        if (!format.url || triedItags.has(format.itag)) continue;
                        triedItags.add(format.itag);
                        const url = new URL(format.url);
                        const mimeType = format.mime_type?.split(";", 1)[0] || "";
                        if (
                            url.protocol !== "https:" || !isGoogleVideoHost(url.hostname)
                            || !mimeType.startsWith("audio/")
                        ) {
                            continue;
                        }
                        const audioData = await downloadMediaAsBase64(url, async () => {
                            const refreshed = await client.getStreamingData(request.videoId, {
                                ...options,
                                itag: format.itag,
                                type: "audio",
                                quality: "best",
                                format: container,
                            });
                            if (
                                !refreshed.url || refreshed.itag !== format.itag
                                || refreshed.content_length !== format.content_length
                                || refreshed.mime_type !== format.mime_type
                            ) {
                                throw new Error("YouTube media format changed during refresh");
                            }
                            const refreshedUrl = new URL(refreshed.url);
                            if (refreshedUrl.protocol !== "https:" || !isGoogleVideoHost(refreshedUrl.hostname)) {
                                throw new Error("YouTube media URL refresh was invalid");
                            }
                            return refreshedUrl;
                        });
                        return success(request.requestId, "youtube", url.href, mimeType, format.bitrate, audioData);
                    } catch {
                        continue;
                    }
                }
            } catch {
                continue;
            }
        }
        return failure(request.requestId, "NOT_PLAYABLE");
    } catch (error) {
        return failure(
            request.requestId,
            "RESOLVE_FAILED",
            error instanceof Error ? error.message : undefined,
        );
    }
};

const createYouTubeClient = async (
    videoId: string,
    siteBaseUrl: string,
    tabId?: number,
): Promise<YouTubeClientSession> => {
    const playbackContext = await queueMediaFrameTask(() => requestYouTubePlaybackContext(videoId, siteBaseUrl, tabId))
        .catch(() => null);
    const client = await Innertube.create({
        generate_session_locally: true,
        retrieve_player: false,
        visitor_data: playbackContext?.visitorData,
        fetch: createYouTubeFetch(siteBaseUrl, playbackContext),
    });
    return { client, playbackContext };
};

const requestYouTubePlaybackContext = (
    videoId: string,
    siteBaseUrl: string,
    tabId?: number,
): Promise<YouTubePlaybackContext> => {
    let framePromise: Promise<MediaFrameHost> | undefined;
    let timeout: ReturnType<typeof setTimeout>;
    let contextTimeout: ReturnType<typeof setTimeout> | undefined;
    let removeListener = (): void => undefined;
    const result = new Promise<YouTubePlaybackContext>((resolve, reject) => {
        let settled = false;
        const finish = (result?: YouTubePlaybackContext, error?: Error): void => {
            if (settled) return;
            settled = true;
            if (result) resolve(result);
            else reject(error || new Error("YouTube playback token was unavailable"));
        };
        const onBeforeRequest = (
            details: chrome.webRequest.OnBeforeRequestDetails,
        ): chrome.webRequest.BlockingResponse | undefined => {
            if (details.tabId !== -1 && details.tabId !== tabId || !details.requestBody?.raw) return undefined;
            void decodeYouTubeRequestBody(details.requestBody.raw).then((payloadText) => {
                if (!payloadText || settled) return;
                const context = readYouTubePlaybackContext(payloadText, videoId);
                if (context?.poToken) {
                    finish(context);
                } else if (context && contextTimeout === undefined) {
                    contextTimeout = setTimeout(() => finish(context), 900);
                }
            }).catch(() => undefined);
            return undefined;
        };
        timeout = setTimeout(() => finish(undefined, new Error("YouTube playback context timed out")), 15_000);
        chrome.webRequest.onBeforeRequest.addListener(
            onBeforeRequest,
            { urls: ["https://www.youtube.com/youtubei/v1/player*"] },
            ["requestBody"],
        );
        removeListener = () => chrome.webRequest.onBeforeRequest.removeListener(onBeforeRequest);
        const tokenPageUrl = new URL("youtube-token.html", siteBaseUrl);
        tokenPageUrl.searchParams.set("video", videoId);
        tokenPageUrl.searchParams.set("resolver", youtubeClientRevision);
        framePromise = openMediaFrame({ type: loadTokenFrameType, tokenPageUrl: tokenPageUrl.href }, tabId);
        void framePromise.catch((error: unknown) =>
            finish(undefined, error instanceof Error ? error : new Error("Media frame unavailable"))
        );
    });
    return result.finally(async () => {
        clearTimeout(timeout);
        clearTimeout(contextTimeout);
        removeListener();
        if (framePromise) await framePromise.then(closeMediaFrame).catch(() => undefined);
    });
};

const queueMediaFrameTask = <T>(run: () => Promise<T>): Promise<T> => {
    const task = mediaFrameQueue.then(run);
    mediaFrameQueue = task.then(() => undefined, () => undefined);
    return task;
};

const openMediaFrame = async (request: MediaFrameRequest, tabId?: number): Promise<MediaFrameHost> => {
    if (Number.isInteger(tabId) && tabId !== undefined && tabId >= 0) {
        try {
            const response = await sendTabMessage(tabId, request);
            if (isSuccessfulFrameLoad(response)) return { kind: "tab", tabId };
        } catch {
        }
    }
    if (!firefoxAndroid && typeof chrome.offscreen?.createDocument === "function") {
        try {
            if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument();
            await chrome.offscreen.createDocument({
                url: "offscreen.html",
                reasons: request.type === loadTokenFrameType
                    ? [chrome.offscreen.Reason.AUDIO_PLAYBACK, chrome.offscreen.Reason.DOM_SCRAPING]
                    : [chrome.offscreen.Reason.DOM_SCRAPING],
                justification: request.type === loadTokenFrameType
                    ? "Generate a YouTube playback token for the requested media"
                    : "Read the public QQ Music playback data selected by the user",
            });
            const response = await chrome.runtime.sendMessage(request) as unknown;
            if (!isSuccessfulFrameLoad(response)) throw new Error("The offscreen media frame did not open");
            return { kind: "offscreen" };
        } catch {
            if (await chrome.offscreen.hasDocument().catch(() => false)) {
                await chrome.offscreen.closeDocument().catch(() => undefined);
            }
        }
    }
    throw new Error("A browser media frame could not be opened");
};

const closeMediaFrame = async (host: MediaFrameHost): Promise<void> => {
    if (host.kind === "offscreen") {
        if (firefoxAndroid) return;
        if (typeof chrome.offscreen?.hasDocument === "function" && await chrome.offscreen.hasDocument()) {
            await chrome.offscreen.closeDocument();
        }
        return;
    }
    await sendTabMessage(host.tabId, { type: removeMediaFrameType }).catch(() => undefined);
};

const sendTabMessage = (tabId: number, message: unknown): Promise<unknown> =>
    new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tabId, message, (response: unknown) => {
            const error = chrome.runtime.lastError;
            if (error) reject(new Error(error.message));
            else resolve(response);
        });
    });

const getSiteBaseUrl = (value: string): string | null => {
    try {
        const url = new URL(value);
        if (url.protocol === "https:" && url.hostname === "lrc.sgmy.org") return `${url.origin}/`;
        if (
            url.protocol === "https:" && url.hostname === "samgum.github.io"
            && (url.pathname === "/lrc-editor" || url.pathname.startsWith("/lrc-editor/"))
        ) {
            return `${url.origin}/lrc-editor/`;
        }
        if (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1")) {
            return `${url.origin}/`;
        }
        return null;
    } catch {
        return null;
    }
};

const resolveBilibili = async (request: BilibiliExtensionRequest): Promise<MediaExtensionResponse> => {
    try {
        const headerMode = await ensureMediaHeaderSupport();
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
                const audioData = headerMode === "legacy"
                    ? await downloadMediaAsBase64(mediaUrl, async () => mediaUrl)
                    : undefined;
                return success(request.requestId, "bilibili", mediaUrl.href, mimeType, format.bandwidth, audioData);
            }
        }
        return failure(request.requestId, "NOT_PLAYABLE");
    } catch {
        return failure(request.requestId, "RESOLVE_FAILED");
    }
};

const resolveNetease = async (request: NeteaseExtensionRequest): Promise<MediaExtensionResponse> => {
    try {
        const songId = request.songId || await resolveNeteaseShortLink(request.url || "");
        const audio = await resolveNeteaseAudioUrl(songId);
        return {
            type: mediaExtensionResponseType,
            requestId: request.requestId,
            ok: true,
            provider: "netease",
            songId,
            audioUrl: audio.url,
            mimeType: audio.mimeType,
        };
    } catch {
        return failure(request.requestId, "RESOLVE_FAILED");
    }
};

const resolveQQMusic = async (request: QQMusicExtensionRequest, tabId?: number): Promise<MediaExtensionResponse> => {
    const key = request.songMid || request.url || "";
    try {
        let pending = qqMusicResolutionPromises.get(key);
        if (!pending) {
            pending = resolveQQMusicFromFrame(request, tabId);
            qqMusicResolutionPromises.set(key, pending);
        }
        const audio = await pending;
        return {
            type: mediaExtensionResponseType,
            requestId: request.requestId,
            ok: true,
            provider: "qqmusic",
            songMid: audio.songMid,
            audioUrl: audio.url,
            mimeType: audio.mimeType,
            duration: audio.duration,
        };
    } catch (error) {
        return failure(
            request.requestId,
            error instanceof QQMusicNotPlayableError ? "NOT_PLAYABLE" : "RESOLVE_FAILED",
            error instanceof Error ? error.message : undefined,
        );
    } finally {
        qqMusicResolutionPromises.delete(key);
    }
};

const resolveQQMusicFromFrame = async (request: QQMusicExtensionRequest, tabId?: number) => {
    const expectedSongMid = request.songMid || extractQQMusicSongMid(request.url || "");
    const frameUrl = expectedSongMid
        ? `https://i2.y.qq.com/n3/other/pages/playsong/index.html?songmid=${expectedSongMid}&type=0&lrc_editor_bridge=1`
        : request.url || "";
    const frame = await queueQQMusicFrame(frameUrl, expectedSongMid, tabId);
    return { ...parseQQMusicPlaybackPage(frame.html, frame.songMid), songMid: frame.songMid };
};

const queueQQMusicFrame = (
    frameUrl: string,
    expectedSongMid: string | null,
    tabId?: number,
): Promise<{ html: string; songMid: string }> => {
    return queueMediaFrameTask(() => loadQQMusicFrame(frameUrl, expectedSongMid, tabId));
};

const loadQQMusicFrame = async (
    frameUrl: string,
    expectedSongMid: string | null,
    tabId?: number,
): Promise<{ html: string; songMid: string }> => {
    await ensureMediaHeaderSupport();
    let frameHost: MediaFrameHost | undefined;
    let failPending: (error: Error) => void = () => undefined;
    try {
        const pending = new Promise<{ html: string; songMid: string }>((resolve, reject) => {
            let settled = false;
            const finish = (value?: { html: string; songMid: string }, error?: Error): void => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                qqMusicFramePending = undefined;
                if (value) resolve(value);
                else reject(error || new Error("QQ Music playback frame failed"));
            };
            const timeout = setTimeout(
                () => finish(undefined, new Error("QQ Music playback frame timed out")),
                15_000,
            );
            qqMusicFramePending = { expectedSongMid, resolve: (value) => finish(value) };
            failPending = (error) => finish(undefined, error);
        });
        try {
            frameHost = await openMediaFrame({ type: loadQQMusicFrameType, frameUrl }, tabId);
        } catch (error) {
            failPending(error instanceof Error ? error : new Error(String(error)));
        }
        return await pending;
    } finally {
        qqMusicFramePending = undefined;
        if (frameHost) await closeMediaFrame(frameHost).catch(() => undefined);
    }
};

const ensureMediaHeaderSupport = (): Promise<"dnr" | "legacy"> => {
    mediaHeaderModePromise ??= (async () => {
        if (!firefoxAndroid && typeof chrome.declarativeNetRequest?.updateSessionRules === "function") {
            try {
                await chrome.declarativeNetRequest.updateSessionRules({
                    removeRuleIds: [qqMusicHeaderRuleId],
                    addRules: [{
                        id: qqMusicHeaderRuleId,
                        priority: 1,
                        action: {
                            type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
                            requestHeaders: [{
                                header: "User-Agent",
                                operation: chrome.declarativeNetRequest.HeaderOperation.SET,
                                value: qqMusicMobileUserAgent,
                            }],
                        },
                        condition: {
                            regexFilter: "^https://i2\\.y\\.qq\\.com/n3/other/pages/playsong/index\\.html\\?",
                            resourceTypes: [chrome.declarativeNetRequest.ResourceType.SUB_FRAME],
                        },
                    }],
                });
                return "dnr";
            } catch {
            }
        }
        installLegacyHeaderRules();
        return "legacy";
    })();
    return mediaHeaderModePromise;
};

const installLegacyHeaderRules = (): void => {
    if (legacyHeaderRulesInstalled) return;
    legacyHeaderRulesInstalled = true;
    chrome.webRequest.onBeforeSendHeaders.addListener(
        (details) => {
            const headers = [...details.requestHeaders || []];
            const url = new URL(details.url);
            if (url.hostname === "i2.y.qq.com") setRequestHeader(headers, "User-Agent", qqMusicMobileUserAgent);
            if (isBilibiliMediaHost(url.hostname)) setRequestHeader(headers, "Referer", "https://www.bilibili.com/");
            return { requestHeaders: headers };
        },
        {
            urls: [
                "https://i2.y.qq.com/n3/other/pages/playsong/index.html*",
                "https://*.bilivideo.com/*",
            ],
            types: ["sub_frame", "xmlhttprequest", "media", "other"],
        },
        ["blocking", "requestHeaders"],
    );
};

const setRequestHeader = (
    headers: chrome.webRequest.HttpHeader[],
    name: string,
    value: string,
): void => {
    const current = headers.find((header) => header.name.toLowerCase() === name.toLowerCase());
    if (current) current.value = value;
    else headers.push({ name, value });
};

const isQQMusicFrameResult = (
    value: unknown,
): value is { type: typeof qqMusicFrameResultType; html: string; songMid: string } => {
    if (typeof value !== "object" || value === null) return false;
    const result = value as Record<string, unknown>;
    return result.type === qqMusicFrameResultType && isQQMusicSongMid(result.songMid)
        && typeof result.html === "string" && result.html.length <= 200_000
        && result.html.includes("__ssrFirstPageData__");
};

const isQQMusicFrameSender = (sender: chrome.runtime.MessageSender, songMid: string): boolean =>
    extractQQMusicSongMid(sender.url || "") === songMid;

const isSuccessfulFrameLoad = (value: unknown): value is { ok: true } =>
    typeof value === "object" && value !== null && (value as Record<string, unknown>).ok === true;

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
    message?: string,
): MediaExtensionResponse => ({
    type: mediaExtensionResponseType,
    requestId,
    ok: false,
    error,
    ...(message ? { message } : {}),
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
        : request.type === neteaseExtensionRequestType
        ? isNeteaseShortUrl(request.url)
            || typeof request.songId === "string" && /^\d{4,}$/.test(request.songId)
        : request.type === qqMusicExtensionRequestType
            && (isQQMusicUrl(request.url) || isQQMusicSongMid(request.songMid));
};

const isGoogleVideoHost = (hostname: string): boolean =>
    hostname === "googlevideo.com" || hostname.endsWith(".googlevideo.com");

const isBilibiliMediaHost = (hostname: string): boolean =>
    hostname === "bilivideo.com" || hostname.endsWith(".bilivideo.com");

const downloadMediaAsBase64 = async (initialUrl: URL, refreshUrl: () => Promise<URL>): Promise<string> => {
    let url = initialUrl;
    let mediaLength = Number.parseInt(url.searchParams.get("clen") || "", 10);
    if (!Number.isSafeInteger(mediaLength) || mediaLength <= 0) {
        const probe = await fetch(url, {
            headers: { Range: "bytes=0-0" },
            credentials: "omit",
            signal: AbortSignal.timeout(10_000),
        });
        const total = /\/(\d+)$/.exec(probe.headers.get("Content-Range") || "")?.[1];
        mediaLength = Number.parseInt(total || "", 10);
    }
    if (!Number.isSafeInteger(mediaLength) || mediaLength <= 0 || mediaLength > 64 * 1024 * 1024) {
        throw new Error("Unsupported YouTube audio size");
    }

    const readRange = async (start: number, end: number): Promise<Uint8Array> => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
                const response = await fetch(url, {
                    headers: { Range: `bytes=${start}-${end}` },
                    credentials: "omit",
                    signal: AbortSignal.timeout(10_000),
                });
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
