if ("serviceWorker" in navigator) {
    const controlledAtStartup = navigator.serviceWorker.controller !== null;
    let reloading = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (!controlledAtStartup || reloading) return;
        const audio = document.querySelector("audio");
        if (audio && (!audio.paused || audio.src.startsWith("blob:"))) return;
        if (document.querySelector(".ai-align-dialog")) return;
        reloading = true;
        location.reload();
    });

    navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" }).then(
        (registration) => {
            void registration.update().catch(() => undefined);
            console.info("LRC Editor service worker registered:", registration.scope);
        },
        (err) => {
            console.error("LRC Editor service worker registration failed:", err);
        },
    );
}
