const swWorker = self as unknown as ServiceWorkerGlobalScope;

const APP_NAME = "lrc-editor";
const VERSION = import.meta.env.app.version;
const HASH = import.meta.env.app.hash;
const CACHENAME = `${APP_NAME}-${VERSION}-${HASH}`;

swWorker.addEventListener("install", () => {
    swWorker.skipWaiting();
});

swWorker.addEventListener("activate", (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all<unknown>([
                swWorker.clients.claim(),
                ...cacheNames
                    .filter((cacheName) => {
                        return cacheName.startsWith(APP_NAME) && cacheName !== CACHENAME;
                    })
                    .map((cacheName) => {
                        return caches.delete(cacheName);
                    }),
            ]);
        }),
    );
});

swWorker.addEventListener("fetch", (event) => {
    if (event.request.method !== "GET") {
        return;
    }

    const url = new URL(event.request.url);
    const cacheableAsset = /\.(?:css|js|png|svg|webmanifest)$/i.test(url.pathname) && url.pathname !== "/sw.js";

    if (url.origin !== swWorker.location.origin || !cacheableAsset) {
        return;
    }

    event.respondWith(
        caches.open(CACHENAME).then(async (cache) => {
            const match = await cache.match(event.request);
            if (match && isExpectedAssetResponse(url, match)) {
                return match;
            }
            if (match) await cache.delete(event.request);

            const response = await fetch(event.request, { cache: "no-store" });
            if (response.type === "basic" && isExpectedAssetResponse(url, response)) {
                event.waitUntil(cache.put(event.request, response.clone()));
            }
            return response;
        }),
    );
});

const isExpectedAssetResponse = (url: URL, response: Response): boolean => {
    if (!response.ok) return false;
    const contentType = (response.headers.get("Content-Type") || "").toLowerCase();
    if (url.pathname.endsWith(".css")) return contentType.includes("text/css");
    if (url.pathname.endsWith(".js")) return contentType.includes("javascript");
    if (url.pathname.endsWith(".png")) return contentType.includes("image/png");
    if (url.pathname.endsWith(".svg")) return contentType.includes("image/svg+xml");
    if (url.pathname.endsWith(".webmanifest")) {
        return contentType.includes("manifest+json") || contentType.includes("application/json");
    }
    return false;
};
