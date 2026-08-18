import type { LocalAlignerRequest } from "../../src/shared/local-aligner-protocol.js";

const youtubeRequestType = "LRC_EDITOR_RESOLVE_YOUTUBE";
const bilibiliRequestType = "LRC_EDITOR_RESOLVE_BILIBILI";
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
): value is { type: string; requestId: string; videoId?: string; url?: string } => {
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
    return request.type === bilibiliRequestType && isBilibiliUrl(request.url);
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

const isResponse = (value: unknown, requestId: string, type: string): value is Record<string, unknown> => {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const response = value as Record<string, unknown>;
    return response.type === type && response.requestId === requestId && typeof response.ok === "boolean";
};
