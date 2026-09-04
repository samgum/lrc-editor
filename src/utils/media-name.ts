const mediaFileExtension = /\.(?:aac|aif|aiff|alac|caf|flac|m4a|m4v|mka|mkv|mov|mp3|mp4|oga|ogg|opus|wav|webm)$/i;

export const safeMediaNameStem = (value: string): string => {
    const cleaned = value.replace(/[\p{Cc}<>:"/\\|?*]+/gu, "_").replace(/\s+/gu, " ").trim();
    const encoder = new TextEncoder();
    let result = "";
    let bytes = 0;
    for (const character of cleaned) {
        bytes += encoder.encode(character).byteLength;
        if (bytes > 160) break;
        result += character;
    }
    result = result.replace(/[. ]+$/, "");
    if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(result)) result = `_${result}`;
    return result;
};

export const mediaFileNameFromUrl = (value: string): string | undefined => {
    try {
        const url = new URL(value);
        if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
        const name = decodeURIComponent(url.pathname.split("/").at(-1) || "");
        const extension = mediaFileExtension.exec(name)?.[0];
        if (!extension) return undefined;
        const stem = safeMediaNameStem(name.slice(0, -extension.length));
        return stem ? `${stem}${extension}` : undefined;
    } catch {
        return undefined;
    }
};

export const readYouTubeMediaLabel = async (videoId: string): Promise<string | undefined> => {
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return undefined;
    const url = new URL("https://www.youtube.com/oembed");
    url.searchParams.set("url", `https://www.youtube.com/watch?v=${videoId}`);
    url.searchParams.set("format", "json");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4_000);
    try {
        const response = await fetch(url.href, {
            signal: controller.signal,
            credentials: "omit",
            referrerPolicy: "no-referrer",
        });
        if (!response.ok) return undefined;
        const metadata = await response.json() as { title?: unknown; author_name?: unknown } | null;
        const title = typeof metadata?.title === "string" ? metadata.title.trim() : "";
        const author = typeof metadata?.author_name === "string"
            ? metadata.author_name.replace(/\s+-\s+Topic$/iu, "").trim()
            : "";
        if (!title) return undefined;
        return author ? `${title} - ${author}` : title;
    } catch {
        return undefined;
    } finally {
        clearTimeout(timeout);
    }
};
