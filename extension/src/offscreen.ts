const loadTokenFrameType = "LRC_EDITOR_LOAD_TOKEN_FRAME";

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || !isLoadRequest(message)) {
        return false;
    }
    const frame = document.createElement("iframe");
    frame.allow = "autoplay; encrypted-media";
    frame.width = "640";
    frame.height = "360";
    frame.src = message.tokenPageUrl;
    document.body.replaceChildren(frame);
    sendResponse({ ok: true });
    return false;
});

const isLoadRequest = (value: unknown): value is { type: typeof loadTokenFrameType; tokenPageUrl: string } => {
    if (typeof value !== "object" || value === null) return false;
    const message = value as Record<string, unknown>;
    if (message.type !== loadTokenFrameType || typeof message.tokenPageUrl !== "string") return false;
    try {
        const url = new URL(message.tokenPageUrl);
        const allowedHost = url.hostname === "lrc.sgmy.org" || url.hostname === "localhost"
            || url.hostname === "127.0.0.1";
        return allowedHost && url.pathname === "/youtube-token.html"
            && /^[A-Za-z0-9_-]{11}$/.test(url.searchParams.get("video") || "");
    } catch {
        return false;
    }
};
