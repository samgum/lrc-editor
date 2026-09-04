const videoId = new URL(location.href).searchParams.get("video") || "";

if (/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
    const frame = document.createElement("iframe");
    frame.allow = "autoplay; encrypted-media";
    frame.referrerPolicy = "strict-origin-when-cross-origin";
    frame.width = "640";
    frame.height = "360";
    frame.addEventListener("load", () => {
        const target = frame.contentWindow;
        target?.postMessage(JSON.stringify({ event: "command", func: "mute", args: [] }), "https://www.youtube.com");
        target?.postMessage(
            JSON.stringify({ event: "command", func: "loadVideoById", args: [videoId] }),
            "https://www.youtube.com",
        );
        target?.postMessage(
            JSON.stringify({ event: "command", func: "playVideo", args: [] }),
            "https://www.youtube.com",
        );
    });
    const url = new URL("https://www.youtube.com/embed/jNQXAC9IVRw");
    url.search = new URLSearchParams({
        autoplay: "1",
        mute: "1",
        playsinline: "1",
        enablejsapi: "1",
        origin: location.origin,
    }).toString();
    frame.src = url.href;
    document.body.replaceChildren(frame);
}
