import {
    extractNeteaseSongId,
    extractQQMusicSongMid,
    isNeteaseShortUrl,
    isQQMusicShortUrl,
} from "../shared/media-extension-protocol.js";
import { alignmentMediaName } from "./alignment-media.js";
import {
    MediaExtensionError,
    requestBilibiliAudio,
    requestNeteaseAudio,
    requestQQMusicAudio,
    requestYouTubeAudio,
} from "./media-extension-bridge.js";
import { mediaFileNameFromUrl, readYouTubeMediaLabel } from "./media-name.js";

export type ParsedMediaInput =
    | { kind: "direct"; url: string; persist: boolean }
    | { kind: "youtube"; originalUrl: string; videoId: string }
    | { kind: "bilibili"; originalUrl: string }
    | { kind: "netease-short"; originalUrl: string }
    | { kind: "netease"; originalUrl: string; songId: string }
    | { kind: "qqmusic-short"; originalUrl: string }
    | { kind: "qqmusic"; originalUrl: string; songMid: string };

export interface ResolvedMediaSource {
    data?: string;
    mimeType?: string;
    name?: string;
    youtubeMusicName?: string;
    src: string;
    persist: boolean;
    provider:
        | "bilibili-extension"
        | "direct"
        | "netease"
        | "netease-extension"
        | "qqmusic-extension"
        | "youtube-extension";
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
            kind: "netease",
            originalUrl: url.href,
            songId: neteaseId,
        };
    }

    if (isQQMusicShortUrl(url.href)) {
        return { kind: "qqmusic-short", originalUrl: url.href };
    }

    const qqMusicSongMid = extractQQMusicSongMid(url);
    if (qqMusicSongMid !== null) {
        return {
            kind: "qqmusic",
            originalUrl: url.href,
            songMid: qqMusicSongMid,
        };
    }

    return { kind: "direct", url: url.href, persist: !isEphemeralUrl(url) };
};

export const resolveMediaInput = async (value: string): Promise<ResolvedMediaSource> => {
    const parsed = parseMediaInput(value);
    if (parsed.kind === "youtube") {
        const [audio, label] = await Promise.all([
            requestYouTubeAudio(parsed.videoId, 90_000, new URL(parsed.originalUrl).hostname === "music.youtube.com"),
            readYouTubeMediaLabel(parsed.videoId),
        ]);
        const musicName = audio.youtubeMusic
            ? [audio.youtubeMusic.title, audio.youtubeMusic.artist].filter(Boolean).join(" - ")
            : undefined;
        return {
            src: audio.url,
            data: audio.data,
            mimeType: audio.mimeType,
            name: alignmentMediaName("youtube", audio.mimeType, musicName || label || `YouTube - ${parsed.videoId}`),
            ...(musicName ? { youtubeMusicName: musicName } : {}),
            persist: false,
            provider: "youtube-extension",
        };
    }
    if (parsed.kind === "bilibili") {
        const audio = await requestBilibiliAudio(parsed.originalUrl);
        return {
            src: audio.url,
            ...(audio.data ? { data: audio.data } : {}),
            mimeType: audio.mimeType,
            persist: false,
            provider: "bilibili-extension",
        };
    }
    if (parsed.kind === "netease-short" || parsed.kind === "netease") {
        try {
            const audio = await requestNeteaseAudio(
                parsed.kind === "netease-short" ? { url: parsed.originalUrl } : { songId: parsed.songId },
            );
            return {
                src: audio.url,
                mimeType: audio.mimeType,
                persist: false,
                provider: "netease-extension",
            };
        } catch (error) {
            if (
                parsed.kind === "netease" && error instanceof MediaExtensionError
                && error.code === "missing"
            ) {
                return {
                    src: `https://music.163.com/song/media/outer/url?id=${parsed.songId}.mp3`,
                    persist: true,
                    provider: "netease",
                };
            }
            throw error;
        }
    }
    if (parsed.kind === "qqmusic-short" || parsed.kind === "qqmusic") {
        const audio = await requestQQMusicAudio(
            parsed.kind === "qqmusic-short" ? { url: parsed.originalUrl } : { songMid: parsed.songMid },
        );
        return {
            src: audio.url,
            mimeType: audio.mimeType,
            persist: false,
            provider: "qqmusic-extension",
        };
    }

    return {
        src: parsed.url,
        name: mediaFileNameFromUrl(parsed.url),
        persist: parsed.persist,
        provider: parsed.url.includes("music.163.com/song/media/outer/url") ? "netease" : "direct",
    };
};

const maxExtensionMediaBytes = 512 * 1024 * 1024;

export interface MaterializeMediaOptions {
    signal?: AbortSignal;
    onBlob?: (blob: Blob) => void;
}

export const materializeExtensionMedia = async (
    source: ResolvedMediaSource,
    options?: MaterializeMediaOptions,
): Promise<string> => {
    if (
        source.provider !== "youtube-extension" && source.provider !== "bilibili-extension"
        && source.provider !== "netease-extension" && source.provider !== "qqmusic-extension"
    ) {
        return source.src;
    }
    try {
        if (source.data) {
            if (source.data.length > Math.ceil(maxExtensionMediaBytes * 4 / 3) + 16) {
                throw new RangeError("Resolved media exceeds maximum supported size");
            }
            const binary = atob(source.data);
            const bytes = new Uint8Array(binary.length);
            for (let index = 0; index < binary.length; index += 1) {
                bytes[index] = binary.charCodeAt(index);
            }
            const media = new Blob([bytes], { type: source.mimeType });
            options?.onBlob?.(media);
            return URL.createObjectURL(media);
        }
        const url = new URL(source.src);
        let mediaLength = Number.parseInt(url.searchParams.get("clen") || "", 10);
        if (!Number.isSafeInteger(mediaLength) || mediaLength <= 0) {
            const probe = await fetch(source.src, {
                credentials: "omit",
                headers: { Range: "bytes=0-0" },
                signal: options?.signal,
            });
            if (probe.status === 200) {
                const fullBuffer = await probe.arrayBuffer();
                if (fullBuffer.byteLength === 0 || fullBuffer.byteLength > maxExtensionMediaBytes) {
                    throw new RangeError("Media response size is invalid");
                }
                const media = new Blob([fullBuffer], { type: source.mimeType });
                options?.onBlob?.(media);
                return URL.createObjectURL(media);
            }
            const total = /\/(\d+)$/.exec(probe.headers.get("Content-Range") || "")?.[1]
                || probe.headers.get("Content-Length")
                || "";
            mediaLength = Number.parseInt(total, 10);
            if (!probe.ok || !Number.isSafeInteger(mediaLength) || mediaLength <= 0) {
                throw new Error(`Media size request failed with status ${probe.status}`);
            }
        }
        if (mediaLength > maxExtensionMediaBytes) {
            throw new RangeError("Resolved media exceeds maximum supported size");
        }
        const chunkSize = 2 * 1024 * 1024;
        const totalChunks = Math.ceil(mediaLength / chunkSize);
        const parts = Array.from<ArrayBuffer>({ length: totalChunks });
        let nextChunk = 0;
        let singleShotBuffer: ArrayBuffer | null = null;
        const downloadWorker = async (): Promise<void> => {
            while (singleShotBuffer === null) {
                const chunkIndex = nextChunk;
                nextChunk += 1;
                if (chunkIndex >= totalChunks) return;
                const start = chunkIndex * chunkSize;
                const end = Math.min(start + chunkSize - 1, mediaLength - 1);
                const response = await fetch(source.src, {
                    credentials: "omit",
                    headers: { Range: `bytes=${start}-${end}` },
                    signal: options?.signal,
                });
                if (!response.ok) {
                    throw new Error(`Media request failed with status ${response.status}`);
                }
                const part = await response.arrayBuffer();
                if (response.status === 200) {
                    if (chunkIndex === 0) singleShotBuffer = part;
                    return;
                }
                parts[chunkIndex] = part;
            }
        };
        await Promise.all(Array.from({ length: Math.min(3, totalChunks) }, () => downloadWorker()));
        const media = new Blob(singleShotBuffer ? [singleShotBuffer] : parts, { type: source.mimeType });
        if (media.size === 0) {
            throw new Error("Media response was empty");
        }
        options?.onBlob?.(media);
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
        const extracted = extractMediaUrl(sharedText);
        const parsed = new URL(extracted);
        const host = parsed.hostname.toLowerCase();
        if (
            host === "localhost"
            || host === "127.0.0.1"
            || host === "[::1]"
            || /^(?:10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host)
        ) {
            return null;
        }
        return extracted;
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
    return parsed.kind === "direct"
        ? parsed.url
        : parsed.kind === "netease"
        ? `https://music.163.com/song/media/outer/url?id=${parsed.songId}.mp3`
        : parsed.originalUrl;
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
