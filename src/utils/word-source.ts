import { createWordTimedDocument, documentToBasicLyrics, parseEnhancedLrc } from "./advanced-lyrics.js";

export const parseWordEditorSource = (source: string) => {
    const document = parseEnhancedLrc(source);
    return createWordTimedDocument(
        documentToBasicLyrics(document),
        new Map(Object.entries(document.metadata)),
        document,
    );
};
