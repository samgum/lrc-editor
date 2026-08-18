const frameResultType = "LRC_EDITOR_QQMUSIC_FRAME_RESULT";

if (window.top !== window) {
    const songMid = new URL(location.href).searchParams.get("songmid") || "";
    const html = document.documentElement.outerHTML;
    if (/^[A-Za-z0-9]{14}$/.test(songMid) && html.includes("__ssrFirstPageData__") && html.length <= 200_000) {
        void chrome.runtime.sendMessage({ type: frameResultType, songMid, html });
    }
}
