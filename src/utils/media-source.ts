import { requestBilibiliAudio, requestYouTubeAudio } from "./media-extension-bridge.js";

export type ParsedMediaInput =
    | { kind: "direct"; url: string; persist: boolean }
    | { kind: "youtube"; originalUrl: string; videoId: string }
    | { kind: "bilibili"; originalUrl: string };

export interface ResolvedMediaSource {
    src: string;
    persist: boolean;
    provider: "bilibili-extension" | "direct" | "netease" | "youtube-extension";
}

export const parseMediaInput = (value: string): ParsedMediaInput => {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new TypeError("Only HTTP(S) media URLs are supported");
    }

    if (isYouTubeHost(url.hostname)) {
        const videoId = extractYouTubeVideoId(url);
        if (videoId === null) {
            throw new TypeError("The YouTube URL does not contain a video id");
        }
        return { kind: "youtube", originalUrl: url.href, videoId };
    }

    if (isBilibiliHost(url.hostname)) {
        if (!isBilibiliVideoUrl(url)) {
            throw new TypeError("The Bilibili URL does not identify a video");
        }
        return { kind: "bilibili", originalUrl: url.href };
    }

    const neteaseId = extractNeteaseSongId(url);
    if (neteaseId !== null) {
        return {
            kind: "direct",
            url: `https://music.163.com/song/media/outer/url?id=${neteaseId}.mp3`,
            persist: true,
        };
    }

    return { kind: "direct", url: url.href, persist: !isEphemeralUrl(url) };
};

export const resolveMediaInput = async (value: string): Promise<ResolvedMediaSource> => {
    const parsed = parseMediaInput(value);
    if (parsed.kind === "youtube") {
        const audio = await requestYouTubeAudio(parsed.videoId);
        return { src: audio.url, persist: false, provider: "youtube-extension" };
    }
    if (parsed.kind === "bilibili") {
        const audio = await requestBilibiliAudio(parsed.originalUrl);
        return { src: audio.url, persist: false, provider: "bilibili-extension" };
    }

    return {
        src: parsed.url,
        persist: parsed.persist,
        provider: parsed.url.includes("music.163.com/song/media/outer/url") ? "netease" : "direct",
    };
};

export const extractSharedMediaUrl = (url: URL): string | null => {
    const search = url.searchParams;
    const explicit = search.get("url");
    if (explicit) {
        return explicit;
    }

    const sharedText = search.get("text") || search.get("title") || "";
    return /https?:\/\/\S+/i.exec(sharedText)?.[0] || null;
};

export const toDirectMediaUrl = (value: string): string => {
    const parsed = parseMediaInput(value);
    return parsed.kind === "direct" ? parsed.url : value;
};

const isYouTubeHost = (hostname: string): boolean => {
    const host = hostname.toLowerCase();
    return host === "youtu.be" || host === "youtube.com" || host.endsWith(".youtube.com")
        || host === "youtube-nocookie.com" || host.endsWith(".youtube-nocookie.com");
};

const isBilibiliVideoUrl = (url: URL): boolean => {
    const host = url.hostname.toLowerCase();
    if (host === "b23.tv") {
        return url.pathname.length > 1;
    }
    if (host !== "bilibili.com" && !host.endsWith(".bilibili.com")) {
        return false;
    }
    return /^\/video\/(?:BV[A-Za-z0-9]+|av\d+)/i.test(url.pathname);
};

const isBilibiliHost = (hostname: string): boolean => {
    const host = hostname.toLowerCase();
    return host === "b23.tv" || host === "bilibili.com" || host.endsWith(".bilibili.com");
};

const extractYouTubeVideoId = (url: URL): string | null => {
    const host = url.hostname.toLowerCase();
    const segments = url.pathname.split("/").filter(Boolean);
    let candidate: string | null = null;

    if (host === "youtu.be") {
        candidate = segments[0] || null;
    } else if (url.pathname === "/watch") {
        candidate = url.searchParams.get("v");
    } else if (["embed", "live", "shorts"].includes(segments[0])) {
        candidate = segments[1] || null;
    }

    return candidate && /^[A-Za-z0-9_-]{11}$/.test(candidate) ? candidate : null;
};

const extractNeteaseSongId = (url: URL): string | null => {
    const host = url.hostname.toLowerCase();
    if (host !== "music.163.com" && !host.endsWith(".music.163.com")) {
        return null;
    }

    const candidate = url.searchParams.get("id") || /\b(\d{4,})\b/.exec(`${url.pathname}${url.hash}`)?.[1];
    return candidate && /^\d{4,}$/.test(candidate) ? candidate : null;
};

const isEphemeralUrl = (url: URL): boolean => {
    if (
        url.hostname === "googlevideo.com" || url.hostname.endsWith(".googlevideo.com")
        || url.hostname === "bilivideo.com" || url.hostname.endsWith(".bilivideo.com")
    ) {
        return true;
    }
    return [...url.searchParams.keys()].some((key) => /auth|expire|key|policy|sig|token/i.test(key));
};
