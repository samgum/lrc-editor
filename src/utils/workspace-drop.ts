import { isLocalMediaFile } from "./local-media.js";
import { createPubSub } from "./pubsub.js";

const lyricFileExtension = /\.(?:krc|lrc|srt|ttml|txt)$/iu;
const encryptedMediaExtension = /\.(?:ncm|qmcflac|qmcogg|qmc[0-3])$/iu;

export interface ClassifiedWorkspaceFiles {
    readonly lyric?: File;
    readonly media?: File;
    readonly unsupported: readonly File[];
    readonly extraLyrics: readonly File[];
    readonly extraMedia: readonly File[];
}

export const isLyricDropFile = (file: File): boolean => lyricFileExtension.test(file.name);

export const isMediaDropFile = (file: File): boolean =>
    isLocalMediaFile(file) || encryptedMediaExtension.test(file.name);

export const classifyWorkspaceFiles = (files: Iterable<File>): ClassifiedWorkspaceFiles => {
    let lyric: File | undefined;
    let media: File | undefined;
    const unsupported: File[] = [];
    const extraLyrics: File[] = [];
    const extraMedia: File[] = [];
    for (const file of files) {
        if (isLyricDropFile(file)) {
            if (lyric) extraLyrics.push(file);
            else lyric = file;
            continue;
        }
        if (isMediaDropFile(file)) {
            if (media) extraMedia.push(file);
            else media = file;
            continue;
        }
        unsupported.push(file);
    }
    return { lyric, media, unsupported, extraLyrics, extraMedia };
};

export const droppedMediaFilePubSub = createPubSub<File, symbol>();
