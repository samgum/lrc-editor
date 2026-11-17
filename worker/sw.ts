import { isExpectedOfflineResponse, isSafeOfflineAssetPath } from "./offline-cache.js";

const swWorker = self as unknown as ServiceWorkerGlobalScope;

const APP_NAME = "lrc-editor";
const VERSION = import.meta.env.app.version;
const HASH = import.meta.env.app.hash;
const CACHENAME = `${APP_NAME}-${VERSION}-${HASH}`;

swWorker.addEventListener("install", (event) => {
    event.waitUntil(precacheOfflineShell().then(() => swWorker.skipWaiting()));
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
    if (url.origin !== swWorker.location.origin) return;

    const scopeUrl = new URL("./", swWorker.registration.scope);
    const indexUrl = new URL("index.html", scopeUrl);
    const swUrl = new URL("sw.js", scopeUrl);
    const tokenHtmlUrl = new URL("youtube-token.html", scopeUrl);
    const tokenScriptUrl = new URL("youtube-token.js", scopeUrl);

    if (event.request.mode === "navigate") {
        if (url.pathname === scopeUrl.pathname || url.pathname === indexUrl.pathname) {
            event.respondWith(navigationResponse(event, scopeUrl, indexUrl));
        }
        return;
    }

    const cacheableAsset = /\.(?:css|js|png|svg|ico|xml|webmanifest)$/i.test(url.pathname)
        && url.pathname !== swUrl.pathname
        && url.pathname !== tokenHtmlUrl.pathname
        && url.pathname !== tokenScriptUrl.pathname;

    if (!cacheableAsset) return;

    event.respondWith(
        caches.open(CACHENAME).then(async (cache) => {
            const cacheKey = url.href;
            const match = await cache.match(cacheKey);
            if (match && isExpectedOfflineResponse(url, match)) {
                return match;
            }
            if (match) await cache.delete(cacheKey);

            const response = await fetch(event.request, { cache: "no-store" });
            if (response.type === "basic" && isExpectedOfflineResponse(url, response)) {
                event.waitUntil(cache.put(cacheKey, response.clone()));
            }
            return response;
        }),
    );
});

const precacheOfflineShell = async (): Promise<void> => {
    const scopeUrl = new URL("./", swWorker.registration.scope);
    const manifestUrl = new URL("offline-assets.json", scopeUrl);
    const manifestResponse = await fetch(manifestUrl, { cache: "no-store" });
    if (!manifestResponse.ok) throw new Error("Offline asset manifest is unavailable");
    const manifest = await manifestResponse.json() as { assets?: unknown };
    if (!Array.isArray(manifest.assets) || !manifest.assets.every(isSafeOfflineAssetPath)) {
        throw new TypeError("Offline asset manifest is invalid");
    }

    const cache = await caches.open(CACHENAME);
    const paths = ["./", ...manifest.assets];
    await Promise.all(paths.map(async (path) => {
        const url = new URL(path, scopeUrl);
        const isRequiredCore = path === "./" || path === "index.html" || /\.(?:css|js)$/i.test(path);
        try {
            const response = await fetch(url.href, { cache: "no-store" });
            if (!isExpectedOfflineResponse(url, response)) {
                throw new TypeError("Unexpected response type");
            }
            await cache.put(url.href, response.clone());
        } catch (error) {
            console.error(`Unable to precache offline asset: ${path}`, error);
            if (isRequiredCore) throw error;
        }
    }));
};

const navigationResponse = async (event: FetchEvent, shellUrl: URL, indexUrl: URL): Promise<Response> => {
    const cache = await caches.open(CACHENAME);
    try {
        const response = await fetch(event.request, { cache: "no-store" });
        if (response.type === "basic" && isExpectedOfflineResponse(shellUrl, response)) {
            event.waitUntil(cache.put(shellUrl.href, response.clone()));
        }
        return response;
    } catch {
        return await cache.match(shellUrl.href) || await cache.match(indexUrl.href) || Response.error();
    }
};
