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

export const resolveNeteaseAudioUrl = async (
    songId: string,
    fetchFn: typeof fetch = (input, init) => globalThis.fetch(input, init),
): Promise<{ url: string; mimeType: string }> => {
    if (!/^\d{4,}$/.test(songId)) throw new TypeError("Invalid NetEase song id");
    const outerUrl = `https://music.163.com/song/media/outer/url?id=${songId}.mp3`;
    const response = await fetchFn(outerUrl, {
        method: "HEAD",
        redirect: "follow",
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
    });
    if (!response.ok) throw new Error("NetEase audio redirect failed");
    const resolved = new URL(response.url);
    const host = resolved.hostname.toLowerCase();
    if (
        resolved.protocol !== "http:" && resolved.protocol !== "https:"
        || (host !== "music.126.net" && !host.endsWith(".music.126.net"))
        || resolved.username !== "" || resolved.password !== ""
    ) {
        throw new Error("NetEase audio redirect returned an unexpected host");
    }
    resolved.protocol = "https:";
    return {
        url: resolved.href,
        mimeType: response.headers.get("Content-Type")?.split(";", 1)[0] || "audio/mpeg",
    };
};
