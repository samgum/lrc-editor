const videoId = new URL(location.href).searchParams.get("video") || "";

if (/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
    const seedId = videoId === "jNQXAC9IVRw" ? "BaW_jenozKc" : "jNQXAC9IVRw";
    const frame = document.createElement("iframe");
    frame.allow = "autoplay; encrypted-media";
    frame.referrerPolicy = "strict-origin-when-cross-origin";
    frame.width = "640";
    frame.height = "360";
    let commanded = false;
    let pollTimer = 0;

    const sendCommands = () => {
        if (commanded) return;
        commanded = true;
        clearInterval(pollTimer);
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
    };

    const pingListening = () => {
        frame.contentWindow?.postMessage(
            JSON.stringify({ event: "listening", id: 1, channel: "widget" }),
            "https://www.youtube.com",
        );
    };

    window.addEventListener("message", (event) => {
        if (event.origin !== "https://www.youtube.com" || event.source !== frame.contentWindow) return;
        sendCommands();
    });

    frame.addEventListener("load", () => {
        pingListening();
        let attempts = 0;
        pollTimer = setInterval(() => {
            attempts += 1;
            if (commanded || attempts > 12) {
                sendCommands();
                return;
            }
            pingListening();
        }, 120);
    });

    const url = new URL(`https://www.youtube.com/embed/${seedId}`);
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
