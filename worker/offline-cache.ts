export const isSafeOfflineAssetPath = (value: unknown): value is string =>
    typeof value === "string"
    && value.length > 0
    && value.length < 256
    && !value.startsWith("/")
    && !value.includes("..")
    && /^(?:\.\/)?[A-Za-z0-9_./-]+$/.test(value);

export const isExpectedOfflineResponse = (url: URL, response: Response): boolean => {
    if (!response.ok) return false;
    const contentType = (response.headers.get("Content-Type") || "").toLowerCase();
    if (url.pathname === "/" || url.pathname.endsWith("/index.html")) return contentType.includes("text/html");
    if (url.pathname.endsWith(".css")) return contentType.includes("text/css");
    if (url.pathname.endsWith(".js")) return contentType.includes("javascript");
    if (url.pathname.endsWith(".png")) return contentType.includes("image/png");
    if (url.pathname.endsWith(".svg")) return contentType.includes("image/svg+xml");
    if (url.pathname.endsWith(".ico")) return contentType.includes("image/");
    if (url.pathname.endsWith(".xml")) return contentType.includes("xml");
    if (url.pathname.endsWith(".json")) return contentType.includes("application/json");
    if (url.pathname.endsWith(".webmanifest")) {
        return contentType.includes("manifest+json") || contentType.includes("application/json");
    }
    return false;
};
