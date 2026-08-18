import { extractNeteaseSongId, isNeteaseShortUrl } from "../shared/media-extension-protocol.js";
import {
    MediaExtensionError,
    requestBilibiliAudio,
    requestNeteaseSongId,
    requestYouTubeAudio,
} from "./media-extension-bridge.js";

export type ParsedMediaInput =
    | { kind: "direct"; url: string; persist: boolean }
    | { kind: "youtube"; originalUrl: string; videoId: string }
    | { kind: "bilibili"; originalUrl: string }
    | { kind: "netease-short"; originalUrl: string };

export interface ResolvedMediaSource {
    data?: string;
    mimeType?: string;
    src: string;
    persist: boolean;
    provider: "bilibili-extension" | "direct" | "netease" | "youtube-extension";
}

export const parseMediaInput = (value: string): ParsedMediaInput => {
    const url = new URL(extractMediaUrl(value));
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

    if (isNeteaseShortUrl(url.href)) {
        return { kind: "netease-short", originalUrl: url.href };
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
        return {
            src: audio.url,
            data: audio.data,
            mimeType: audio.mimeType,
            persist: false,
            provider: "youtube-extension",
        };
    }
    if (parsed.kind === "bilibili") {
        const audio = await requestBilibiliAudio(parsed.originalUrl);
        return { src: audio.url, mimeType: audio.mimeType, persist: false, provider: "bilibili-extension" };
    }
    if (parsed.kind === "netease-short") {
        const songId = await requestNeteaseSongId(parsed.originalUrl);
        return {
            src: `https://music.163.com/song/media/outer/url?id=${songId}.mp3`,
            persist: true,
            provider: "netease",
        };
    }

    return {
        src: parsed.url,
        persist: parsed.persist,
        provider: parsed.url.includes("music.163.com/song/media/outer/url") ? "netease" : "direct",
    };
};

export const materializeExtensionMedia = async (source: ResolvedMediaSource): Promise<string> => {
    if (source.provider !== "youtube-extension" && source.provider !== "bilibili-extension") {
        return source.src;
    }
    try {
        if (source.data) {
            const binary = atob(source.data);
            const bytes = new Uint8Array(binary.length);
            for (let index = 0; index < binary.length; index += 1) {
                bytes[index] = binary.charCodeAt(index);
            }
            return URL.createObjectURL(new Blob([bytes], { type: source.mimeType }));
        }
        const url = new URL(source.src);
        let mediaLength = Number.parseInt(url.searchParams.get("clen") || "", 10);
        if (!Number.isSafeInteger(mediaLength) || mediaLength <= 0) {
            const probe = await fetch(source.src, {
                credentials: "omit",
                headers: { Range: "bytes=0-0" },
            });
            const total = /\/(\d+)$/.exec(probe.headers.get("Content-Range") || "")?.[1];
            mediaLength = Number.parseInt(total || "", 10);
            if (!probe.ok || !Number.isSafeInteger(mediaLength) || mediaLength <= 0) {
                throw new Error(`Media size request failed with status ${probe.status}`);
            }
        }
        const parts: ArrayBuffer[] = [];
        const chunkSize = 1024 * 1024;
        for (let start = 0; start < mediaLength; start += chunkSize) {
            const end = Math.min(start + chunkSize - 1, mediaLength - 1);
            const response = await fetch(source.src, {
                credentials: "omit",
                headers: { Range: `bytes=${start}-${end}` },
            });
            if (!response.ok) {
                throw new Error(`Media request failed with status ${response.status}`);
            }
            const part = await response.arrayBuffer();
            if (response.status === 200) {
                parts.splice(0, parts.length, part);
                break;
            }
            parts.push(part);
        }
        const media = new Blob(parts, { type: source.mimeType });
        if (media.size === 0) {
            throw new Error("Media response was empty");
        }
        return URL.createObjectURL(media);
    } catch (error) {
        throw new MediaExtensionError(
            "failed",
            error instanceof Error ? error.message : "Resolved media could not be loaded",
        );
    }
};

export const extractSharedMediaUrl = (url: URL): string | null => {
    const search = url.searchParams;
    const explicit = search.get("url");
    const sharedText = explicit || search.get("text") || search.get("title") || "";
    try {
        return extractMediaUrl(sharedText);
    } catch {
        return null;
    }
};

export const extractMediaUrl = (value: string): string => {
    const match = /https?:\/\/[^\s<>"']+/iu.exec(value.trim());
    if (!match) throw new TypeError("The media input does not contain an HTTP(S) URL");
    const candidate = match[0].replace(/[.,!?;:，。！？；：、)\]}】》”’]+$/u, "");
    const url = new URL(candidate);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new TypeError("Only HTTP(S) media URLs are supported");
    }
    return url.href;
};

export const toDirectMediaUrl = (value: string): string => {
    const parsed = parseMediaInput(value);
    return parsed.kind === "direct" ? parsed.url : parsed.originalUrl;
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

const isEphemeralUrl = (url: URL): boolean => {
    if (
        url.hostname === "googlevideo.com" || url.hostname.endsWith(".googlevideo.com")
        || url.hostname === "bilivideo.com" || url.hostname.endsWith(".bilivideo.com")
    ) {
        return true;
    }
    return [...url.searchParams.keys()].some((key) => /auth|expire|key|policy|sig|token/i.test(key));
};
