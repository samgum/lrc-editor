import { safeMediaNameStem } from "./media-name.js";

export interface AlignmentMediaSource {
    blob?: Blob;
    name: string;
    url?: string;
}

let currentSource: AlignmentMediaSource | undefined;

export const setAlignmentMediaSource = (source: AlignmentMediaSource): void => {
    currentSource = source;
};

export const clearAlignmentMediaSource = (): void => {
    currentSource = undefined;
};

export const getAlignmentMediaSource = async (): Promise<{ blob: Blob; name: string }> => {
    if (!currentSource) throw new Error("NO_MEDIA");
    if (currentSource.blob) return { blob: currentSource.blob, name: currentSource.name };
    if (!currentSource.url) throw new Error("NO_MEDIA");
    const response = await fetch(currentSource.url, { credentials: "omit" });
    if (!response.ok) throw new Error("MEDIA_UNAVAILABLE");
    const blob = await response.blob();
    if (blob.size === 0) throw new Error("MEDIA_UNAVAILABLE");
    currentSource = { ...currentSource, blob };
    return { blob, name: currentSource.name };
};

export const alignmentMediaName = (provider: string, mimeType?: string, label?: string): string => {
    const type = mimeType?.split(";", 1)[0].trim().toLowerCase();
    const extension = type?.includes("mp4")
        ? type.startsWith("video/") ? "mp4" : "m4a"
        : type?.includes("webm")
        ? "webm"
        : type?.includes("aac")
        ? "aac"
        : type?.includes("opus")
        ? "opus"
        : type?.includes("flac")
        ? "flac"
        : type?.includes("ogg")
        ? "ogg"
        : type?.includes("wav")
        ? "wav"
        : "mp3";
    return `${safeMediaNameStem(label || "") || `${provider}-audio`}.${extension}`;
};
