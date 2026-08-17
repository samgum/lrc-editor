const mediaExtension = /\.(?:aac|aif|aiff|alac|caf|flac|m4a|m4v|mka|mkv|mov|mp3|mp4|oga|ogg|opus|wav|webm)$/i;
const scanBytes = 1024 * 1024;

export const isLocalMediaFile = (file: File): boolean =>
    file.type.startsWith("audio/") || file.type.startsWith("video/") || mediaExtension.test(file.name);

export const needsCodecFallback = async (file: File, audio = document.createElement("audio")): Promise<boolean> => {
    const codec = await detectLosslessCodec(file);
    if (codec === null) {
        return false;
    }
    const contentType = {
        aiff: "audio/aiff",
        alac: "audio/mp4; codecs=\"alac\"",
        caf: "audio/x-caf",
        flac: "audio/flac",
        matroska: "audio/x-matroska",
        ogg: "audio/ogg",
        opus: "audio/ogg; codecs=\"opus\"",
        quicktime: "video/quicktime",
    }[codec];
    return contentType ? audio.canPlayType(contentType) === "" : false;
};

export const detectLosslessCodec = async (
    file: File,
): Promise<"aiff" | "alac" | "caf" | "flac" | "matroska" | "ogg" | "opus" | "quicktime" | null> => {
    if (/\.flac$/i.test(file.name) || file.type === "audio/flac" || file.type === "audio/x-flac") {
        return "flac";
    }
    if (/\.alac$/i.test(file.name)) {
        return "alac";
    }
    if (/\.caf$/i.test(file.name)) {
        return "caf";
    }
    if (/\.aiff?$/i.test(file.name)) {
        return "aiff";
    }
    if (/\.(?:mka|mkv)$/i.test(file.name)) {
        return "matroska";
    }
    if (/\.opus$/i.test(file.name)) {
        return "opus";
    }
    if (/\.(?:oga|ogg)$/i.test(file.name)) {
        return "ogg";
    }
    if (/\.mov$/i.test(file.name)) {
        return "quicktime";
    }
    if (!/\.(?:m4a|mp4|mov)$/i.test(file.name) && !/^(?:audio|video)\/mp4$/.test(file.type)) {
        return null;
    }

    const head = new Uint8Array(await file.slice(0, Math.min(file.size, scanBytes)).arrayBuffer());
    if (hasAsciiMarker(head, "alac")) {
        return "alac";
    }
    if (file.size > scanBytes) {
        const tail = new Uint8Array(await file.slice(Math.max(0, file.size - scanBytes)).arrayBuffer());
        if (hasAsciiMarker(tail, "alac")) {
            return "alac";
        }
    }
    return null;
};

const hasAsciiMarker = (data: Uint8Array, marker: string): boolean => {
    const bytes = [...marker].map((character) => character.charCodeAt(0));
    return data.some((_, index) => bytes.every((value, offset) => data[index + offset] === value));
};
