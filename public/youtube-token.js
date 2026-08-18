const videoId = new URL(location.href).searchParams.get("video") || "";

if (/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
    const frame = document.createElement("iframe");
    frame.allow = "autoplay; encrypted-media";
    frame.width = "640";
    frame.height = "360";
    frame.addEventListener("load", () => {
        const target = frame.contentWindow;
        target?.postMessage(JSON.stringify({ event: "command", func: "mute", args: [] }), "https://www.youtube.com");
        target?.postMessage(
            JSON.stringify({ event: "command", func: "playVideo", args: [] }),
            "https://www.youtube.com",
        );
    });
    frame.src = `https://www.youtube.com/embed/${videoId}?autoplay=1&mute=1&playsinline=1&enablejsapi=1`;
    document.body.replaceChildren(frame);
}
