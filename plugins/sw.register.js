if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" }).then(
        (registration) => {
            registration.update();
            console.info("LRC Editor service worker registered:", registration.scope);
        },
        (err) => {
            console.error("LRC Editor service worker registration failed:", err);
        },
    );
}
