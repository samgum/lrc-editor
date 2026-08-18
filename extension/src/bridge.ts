import type { LocalAlignerRequest } from "../../src/shared/local-aligner-protocol.js";

const youtubeRequestType = "LRC_EDITOR_RESOLVE_YOUTUBE";
const bilibiliRequestType = "LRC_EDITOR_RESOLVE_BILIBILI";
const neteaseRequestType = "LRC_EDITOR_RESOLVE_NETEASE";
const qqMusicRequestType = "LRC_EDITOR_RESOLVE_QQMUSIC";
const ackType = "LRC_EDITOR_MEDIA_ACK";
const responseType = "LRC_EDITOR_MEDIA_RESULT";
const alignerResponseType = "LRC_EDITOR_ALIGNER_RESULT";
const alignerRequestTypes = new Set([
    "LRC_EDITOR_ALIGNER_START",
    "LRC_EDITOR_ALIGNER_CHUNK",
    "LRC_EDITOR_ALIGNER_COMMIT",
    "LRC_EDITOR_ALIGNER_STATUS",
    "LRC_EDITOR_ALIGNER_RESULT_REQUEST",
    "LRC_EDITOR_ALIGNER_CLEANUP",
    "LRC_EDITOR_ALIGNER_CANCEL",
    "LRC_EDITOR_ALIGNER_SERVICE_STOP",
    "LRC_EDITOR_ALIGNER_CACHE_CLEAR",
]);

window.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (event.source !== window || event.origin !== location.origin || !isRequest(event.data)) {
        return;
    }
    const request = event.data;
    const expectedResponseType = isLocalAlignerRequest(request) ? alignerResponseType : responseType;
    window.postMessage(
        { type: ackType, requestId: request.requestId, version: chrome.runtime.getManifest().version },
        location.origin,
    );

    void chrome.runtime.sendMessage(request).then(
        (response: unknown) => {
            if (isResponse(response, request.requestId, expectedResponseType)) {
                window.postMessage(response, location.origin);
            } else {
                postFailure(request.requestId, expectedResponseType);
            }
        },
        () => postFailure(request.requestId, expectedResponseType),
    );
});

const postFailure = (requestId: string, type: string): void => {
    window.postMessage(
        { type, requestId, ok: false, error: type === alignerResponseType ? "ALIGNER_FAILED" : "RESOLVE_FAILED" },
        location.origin,
    );
};

const isRequest = (
    value: unknown,
): value is {
    type: string;
    requestId: string;
    videoId?: string;
    url?: string;
    songId?: string;
    songMid?: string;
} => {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    if (isLocalAlignerRequest(value)) return true;
    const request = value as Record<string, unknown>;
    if (typeof request.requestId !== "string") {
        return false;
    }
    if (request.type === youtubeRequestType) {
        return typeof request.videoId === "string" && /^[A-Za-z0-9_-]{11}$/.test(request.videoId);
    }
    return request.type === bilibiliRequestType
        ? isBilibiliUrl(request.url)
        : request.type === neteaseRequestType
        ? isNeteaseShortUrl(request.url)
            || typeof request.songId === "string" && /^\d{4,}$/.test(request.songId)
        : request.type === qqMusicRequestType
            && (isQQMusicUrl(request.url)
                || typeof request.songMid === "string" && /^[A-Za-z0-9]{14}$/.test(request.songMid));
};

const isLocalAlignerRequest = (value: unknown): value is LocalAlignerRequest => {
    if (typeof value !== "object" || value === null) return false;
    const request = value as Record<string, unknown>;
    return typeof request.requestId === "string" && request.requestId.length >= 8
        && typeof request.type === "string" && alignerRequestTypes.has(request.type);
};

const isBilibiliUrl = (value: unknown): boolean => {
    if (typeof value !== "string") {
        return false;
    }
    try {
        const url = new URL(value);
        const host = url.hostname.toLowerCase();
        return host === "b23.tv"
            ? url.pathname.length > 1
            : (host === "bilibili.com" || host.endsWith(".bilibili.com"))
                && /^\/video\/(?:BV[A-Za-z0-9]+|av\d+)/i.test(url.pathname);
    } catch {
        return false;
    }
};

const isNeteaseShortUrl = (value: unknown): boolean => {
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

const isQQMusicUrl = (value: unknown): boolean => {
    if (typeof value !== "string") return false;
    try {
        const url = new URL(value);
        const host = url.hostname.toLowerCase();
        if (host === "c6.y.qq.com") {
            return url.protocol === "https:" && url.port === "" && url.pathname === "/base/fcgi-bin/u"
                && /^[A-Za-z0-9_-]{6,64}$/.test(url.searchParams.get("__") || "");
        }
        if (host === "y.qq.com") {
            return /^\/n\/ryqq(?:_v2)?\/songDetail\/[A-Za-z0-9]{14}\/?$/i.test(url.pathname);
        }
        return (host === "i.y.qq.com" && url.pathname === "/v8/playsong.html"
            || host === "i2.y.qq.com" && url.pathname === "/n3/other/pages/playsong/index.html")
            && /^[A-Za-z0-9]{14}$/.test(url.searchParams.get("songmid") || "");
    } catch {
        return false;
    }
};

const isResponse = (value: unknown, requestId: string, type: string): value is Record<string, unknown> => {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const response = value as Record<string, unknown>;
    return response.type === type && response.requestId === requestId && typeof response.ok === "boolean";
};
