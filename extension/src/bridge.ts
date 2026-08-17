const youtubeRequestType = "LRC_EDITOR_RESOLVE_YOUTUBE";
const bilibiliRequestType = "LRC_EDITOR_RESOLVE_BILIBILI";
const ackType = "LRC_EDITOR_MEDIA_ACK";
const responseType = "LRC_EDITOR_MEDIA_RESULT";

window.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (event.source !== window || event.origin !== location.origin || !isRequest(event.data)) {
        return;
    }
    const request = event.data;
    window.postMessage(
        { type: ackType, requestId: request.requestId, version: chrome.runtime.getManifest().version },
        location.origin,
    );

    void chrome.runtime.sendMessage(request).then(
        (response: unknown) => {
            if (isResponse(response, request.requestId)) {
                window.postMessage(response, location.origin);
            } else {
                postFailure(request.requestId);
            }
        },
        () => postFailure(request.requestId),
    );
});

const postFailure = (requestId: string): void => {
    window.postMessage(
        { type: responseType, requestId, ok: false, error: "RESOLVE_FAILED" },
        location.origin,
    );
};

const isRequest = (
    value: unknown,
): value is { type: string; requestId: string; videoId?: string; url?: string } => {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const request = value as Record<string, unknown>;
    if (typeof request.requestId !== "string") {
        return false;
    }
    if (request.type === youtubeRequestType) {
        return typeof request.videoId === "string" && /^[A-Za-z0-9_-]{11}$/.test(request.videoId);
    }
    return request.type === bilibiliRequestType && isBilibiliUrl(request.url);
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

const isResponse = (value: unknown, requestId: string): value is Record<string, unknown> => {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const response = value as Record<string, unknown>;
    return response.type === responseType && response.requestId === requestId && typeof response.ok === "boolean";
};
