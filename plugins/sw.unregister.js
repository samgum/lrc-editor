globalThis.__lrcEditorUnregister = async function(reload = true) {
    const APP_NAME = "lrc-editor";

    if ("caches" in window) {
        const cacheNames = await caches.keys();
        await Promise.all(
            cacheNames
                .filter((cacheName) => cacheName.startsWith(APP_NAME))
                .map((cacheName) => caches.delete(cacheName)),
        );
    }

    if ("serviceWorker" in navigator) {
        const registration = await navigator.serviceWorker.getRegistration("./");
        if (registration) await registration.unregister();
    }

    if (reload) location.reload();
};
