const loadTokenFrameType = "LRC_EDITOR_LOAD_TOKEN_FRAME";
const loadQQMusicFrameType = "LRC_EDITOR_LOAD_QQMUSIC_FRAME";

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) {
        return false;
    }
    if (isLoadQQMusicRequest(message)) {
        const frame = document.createElement("iframe");
        frame.width = "1";
        frame.height = "1";
        frame.referrerPolicy = "no-referrer";
        frame.src = message.frameUrl;
        document.body.replaceChildren(frame);
        sendResponse({ ok: true });
        return false;
    }
    if (!isLoadRequest(message)) return false;
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

const isLoadQQMusicRequest = (
    value: unknown,
): value is { type: typeof loadQQMusicFrameType; frameUrl: string } => {
    if (typeof value !== "object" || value === null) return false;
    const message = value as Record<string, unknown>;
    if (message.type !== loadQQMusicFrameType || typeof message.frameUrl !== "string") return false;
    try {
        const url = new URL(message.frameUrl);
        if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return false;
        if (url.hostname === "c6.y.qq.com") {
            return url.pathname === "/base/fcgi-bin/u"
                && /^[A-Za-z0-9_-]{6,64}$/.test(url.searchParams.get("__") || "");
        }
        return url.hostname === "i2.y.qq.com" && url.pathname === "/n3/other/pages/playsong/index.html"
            && /^[A-Za-z0-9]{14}$/.test(url.searchParams.get("songmid") || "");
    } catch {
        return false;
    }
};
