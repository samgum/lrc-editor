import { extractNeteaseSongId, isNeteaseShortUrl } from "../../src/shared/media-extension-protocol.js";

export const resolveNeteaseShortLink = async (
    value: string,
    fetchFn: typeof fetch = (input, init) => globalThis.fetch(input, init),
): Promise<string> => {
    if (!isNeteaseShortUrl(value)) throw new TypeError("Invalid NetEase short URL");

    for (const method of ["HEAD", "GET"] as const) {
        const response = await fetchFn(value, {
            method,
            redirect: "follow",
            credentials: "omit",
            cache: "no-store",
            referrerPolicy: "no-referrer",
        });
        if (!response.ok) continue;
        const resolved = new URL(response.url);
        const songId = resolved.protocol === "https:" ? extractNeteaseSongId(resolved) : null;
        if (songId !== null) return songId;
    }
    throw new Error("NetEase short link did not resolve to a song");
};
