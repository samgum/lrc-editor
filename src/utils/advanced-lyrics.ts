import { unzlibSync, zlibSync } from "fflate";

export type LyricFormat = "lrc" | "enhanced-lrc" | "krc" | "ttml" | "srt";
export type LyricTimingMode = "line" | "word";
export type LyricsWorkspaceMode = "line" | "word";

export interface TimedWord {
    readonly text: string;
    readonly startMs?: number;
    readonly endMs?: number;
}

export interface AdvancedLyricLine {
    readonly startMs?: number;
    readonly endMs?: number;
    readonly words: readonly TimedWord[];
}

export interface AdvancedLyricsDocument {
    readonly sourceFormat: LyricFormat;
    readonly timingMode: LyricTimingMode;
    readonly metadata: Readonly<Record<string, string>>;
    readonly lines: readonly AdvancedLyricLine[];
}

export type ExportLyricFormat = "lrc" | "enhanced-lrc" | "krc" | "ttml" | "srt";
export type LineLyricExportFormat = "lrc" | "srt" | "ttml" | "txt";

const KRC_MAGIC = new Uint8Array([0x6b, 0x72, 0x63, 0x31]);
const KRC_XOR_KEY = new Uint8Array([
    0x40,
    0x47,
    0x61,
    0x77,
    0x5e,
    0x32,
    0x74,
    0x47,
    0x51,
    0x36,
    0x31,
    0x2d,
    0xce,
    0xd2,
    0x6e,
    0x69,
]);

const lineTimeTag = /\[\s*(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\s*\]/gu;
const wordTimeTag = /<\s*(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\s*>/gu;
const infoTag = /^\[\s*([\w-]{1,32})\s*:(.*?)\]\s*$/u;

const textEncoder = new TextEncoder();

export const lineText = (line: Pick<AdvancedLyricLine, "words">): string =>
    line.words.map((word) => word.text).join("");

export const displayLineText = (line: Pick<AdvancedLyricLine, "words">): string =>
    lineText(line).replace(/\s*\r?\n\s*/gu, " / ");

export const hasWordTiming = (document: AdvancedLyricsDocument | null): boolean =>
    document?.timingMode === "word"
    && document.lines.some((line) => line.words.some((word) => word.startMs !== undefined || word.endMs !== undefined));

export const parseLrcTimestamp = (minutes: string, seconds: string): number => {
    const normalizedSeconds = seconds.replace(":", ".");
    return Math.round((Number.parseInt(minutes, 10) * 60 + Number.parseFloat(normalizedSeconds)) * 1000);
};

export const parseFlexibleTimestamp = (value: string): number | undefined => {
    let trimmed = value.trim();
    if (trimmed.startsWith("[") || trimmed.startsWith("<")) trimmed = trimmed.slice(1);
    if (trimmed.endsWith("]") || trimmed.endsWith(">")) trimmed = trimmed.slice(0, -1);
    if (!trimmed) return undefined;
    const parts = trimmed.split(":");
    let seconds: number;
    if (parts.length === 1) {
        seconds = Number.parseFloat(parts[0]);
    } else if (parts.length === 2) {
        seconds = Number.parseInt(parts[0], 10) * 60 + Number.parseFloat(parts[1].replace(",", "."));
    } else if (parts.length === 3) {
        seconds = Number.parseInt(parts[0], 10) * 3600
            + Number.parseInt(parts[1], 10) * 60
            + Number.parseFloat(parts[2].replace(",", "."));
    } else {
        return undefined;
    }
    return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : undefined;
};

export const formatLrcTimestamp = (milliseconds: number, fixed: Fixed, brackets: "square" | "angle" = "square") => {
    const safeMilliseconds = Math.max(0, Math.round(milliseconds));
    const factor = 10 ** (3 - fixed);
    const roundedUnits = Math.round(safeMilliseconds / factor);
    const unitsPerMinute = 60 * 10 ** fixed;
    const minutes = Math.floor(roundedUnits / unitsPerMinute);
    const secondsUnits = roundedUnits % unitsPerMinute;
    const integerSeconds = Math.floor(secondsUnits / 10 ** fixed);
    const fraction = fixed === 0 ? "" : `.${(secondsUnits % 10 ** fixed).toString().padStart(fixed, "0")}`;
    const value = `${minutes.toString().padStart(2, "0")}:${integerSeconds.toString().padStart(2, "0")}${fraction}`;
    return brackets === "square" ? `[${value}]` : `<${value}>`;
};

export const parseEnhancedLrc = (source: string): AdvancedLyricsDocument => {
    const metadata: Record<string, string> = {};
    const lines: AdvancedLyricLine[] = [];
    let timingMode: LyricTimingMode = "line";
    const sourceLines = normalizeLineEndings(source).split("\n");
    if (sourceLines.at(-1) === "") sourceLines.pop();

    for (const rawLine of sourceLines) {
        const metadataMatch = infoTag.exec(rawLine);
        if (metadataMatch && !/^\d+$/u.test(metadataMatch[1])) {
            const value = metadataMatch[2].trim();
            if (value) metadata[metadataMatch[1]] = value;
            continue;
        }

        lineTimeTag.lastIndex = 0;
        const timeMatches = Array.from(rawLine.matchAll(lineTimeTag));
        if (timeMatches.length === 0) {
            lines.push({ words: [{ text: rawLine }] });
            continue;
        }

        const contentStart = timeMatches.at(-1)!.index! + timeMatches.at(-1)![0].length;
        const content = rawLine.slice(contentStart);
        const parsedWords = parseEnhancedWords(content, parseLrcTimestamp(timeMatches[0][1], timeMatches[0][2]));
        if (parsedWords.wordTimed) timingMode = "word";

        for (const match of timeMatches) {
            lines.push({
                startMs: parseLrcTimestamp(match[1], match[2]),
                endMs: parsedWords.endMs,
                words: parsedWords.words,
            });
        }
    }

    return {
        sourceFormat: timingMode === "word" ? "enhanced-lrc" : "lrc",
        timingMode,
        metadata,
        lines,
    };
};

const parseEnhancedWords = (content: string, lineStartMs: number): {
    words: TimedWord[];
    endMs?: number;
    wordTimed: boolean;
} => {
    wordTimeTag.lastIndex = 0;
    const matches = Array.from(content.matchAll(wordTimeTag));
    if (matches.length === 0) {
        return { words: [{ text: content }], wordTimed: false };
    }

    const words: TimedWord[] = [];
    let cursor = 0;
    let activeStart = lineStartMs;

    for (const match of matches) {
        const text = content.slice(cursor, match.index);
        const tagTime = parseLrcTimestamp(match[1], match[2]);
        if (text) {
            words.push({ text, startMs: activeStart, endMs: tagTime });
        }
        activeStart = tagTime;
        cursor = match.index! + match[0].length;
    }

    const trailingText = content.slice(cursor);
    if (trailingText) {
        words.push({ text: trailingText, startMs: activeStart });
        return { words, wordTimed: true };
    }

    if (words.length === 0) {
        return { words: [{ text: "", startMs: lineStartMs, endMs: activeStart }], endMs: activeStart, wordTimed: true };
    }
    const last = words.at(-1)!;
    if (last.endMs === undefined) words[words.length - 1] = { ...last, endMs: activeStart };
    return { words, endMs: activeStart, wordTimed: true };
};

export const parseKrc = (input: string | Uint8Array): AdvancedLyricsDocument => {
    const source = typeof input === "string" ? input : decodeKrc(input);
    const metadata: Record<string, string> = {};
    const lines: AdvancedLyricLine[] = [];
    let foundWordTiming = false;

    for (const rawLine of normalizeLineEndings(source).split("\n")) {
        const match = /^\[(\d+),(\d+)\](.*)$/u.exec(rawLine);
        if (!match) {
            const metadataMatch = infoTag.exec(rawLine);
            if (metadataMatch) metadata[metadataMatch[1]] = metadataMatch[2].trim();
            continue;
        }
        const lineStart = Number.parseInt(match[1], 10);
        const lineDuration = Number.parseInt(match[2], 10);
        const content = match[3];
        const words: TimedWord[] = [];
        const wordPattern = /<(\d+),(\d+),(-?\d+)>([^<]*)/gu;
        for (const wordMatch of content.matchAll(wordPattern)) {
            const relativeStart = Number.parseInt(wordMatch[1], 10);
            const duration = Number.parseInt(wordMatch[2], 10);
            words.push({
                text: wordMatch[4],
                startMs: lineStart + relativeStart,
                endMs: lineStart + relativeStart + duration,
            });
        }
        if (words.length > 0) foundWordTiming = true;
        lines.push({
            startMs: lineStart,
            endMs: lineStart + lineDuration,
            words: words.length > 0 ? words : [{ text: content }],
        });
    }

    if (lines.length === 0) throw new Error("No KRC lyric lines were found");
    return { sourceFormat: "krc", timingMode: foundWordTiming ? "word" : "line", metadata, lines };
};

export const decodeKrc = (input: Uint8Array): string => {
    if (!startsWithBytes(input, KRC_MAGIC)) return decodeTextBytes(input);
    const compressed = input.subarray(KRC_MAGIC.length).map((value, index) =>
        value ^ KRC_XOR_KEY[index % KRC_XOR_KEY.length]
    );
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(unzlibSync(compressed));
    } catch (error) {
        const failure = new Error("The KRC file is damaged or uses an unsupported compression variant");
        (failure as Error & { cause?: unknown }).cause = error;
        throw failure;
    }
};

type XmlParser = (source: string) => Document;

const browserXmlParser: XmlParser = (source) => new DOMParser().parseFromString(source, "application/xml");

export const parseTtml = (source: string, parseXml: XmlParser = browserXmlParser): AdvancedLyricsDocument => {
    if (/<!DOCTYPE/iu.test(source)) throw new Error("TTML files with a document type declaration are not supported");
    const document = parseXml(source.replace(/<\/p >/gu, "</p>"));
    if (
        localName(document.documentElement) === "parsererror"
        || allElements(document).some((el) => localName(el) === "parsererror")
    ) {
        throw new Error("The TTML file is not valid XML");
    }
    const root = document.documentElement;
    if (localName(root) !== "tt") throw new Error("The XML file is not TTML");

    const frameRate = Number.parseFloat(attributeByLocalName(root, "frameRate") || "30") || 30;
    const metadata = readTtmlMetadata(document);
    const lines: AdvancedLyricLine[] = [];
    let foundWordTiming = false;

    for (const paragraph of allElements(document).filter((element) => localName(element) === "p")) {
        const paragraphStart = parseTtmlTime(attributeByLocalName(paragraph, "begin"), frameRate);
        const paragraphEnd = resolveTtmlEnd(paragraph, paragraphStart, frameRate);
        const leaves = leafTimedSpans(paragraph);
        const mainLeaves = leaves.filter((span) => !hasBackgroundAncestor(span, paragraph));
        const backgroundLeaves = leaves.filter((span) => hasBackgroundAncestor(span, paragraph));

        if (mainLeaves.length === 0) {
            const text = cleanXmlText(paragraph.textContent || "").trim();
            lines.push({
                startMs: paragraphStart,
                endMs: paragraphEnd,
                words: [{ text }],
            });
            continue;
        }

        const words: TimedWord[] = mainLeaves.map((span) => {
            const startMs = parseTtmlTime(attributeByLocalName(span, "begin"), frameRate);
            const endMs = resolveTtmlEnd(span, startMs, frameRate);
            return {
                text: cleanXmlText(span.textContent || "") + tailText(span, paragraph),
                startMs,
                endMs,
            } satisfies TimedWord;
        });
        const leading = leadingText(paragraph);
        if (leading) words.unshift({ text: leading });
        const backgroundText = backgroundLeaves.map((span) =>
            cleanXmlText(span.textContent || "") + tailText(span, paragraph)
        ).join("").trim();
        if (backgroundText) {
            const parenthesized = backgroundText.startsWith("(") && backgroundText.endsWith(")")
                ? backgroundText
                : `(${backgroundText})`;
            const spacer = words.at(-1)?.text.endsWith(" ") ? "" : " ";
            words.push({ text: spacer + parenthesized });
        }

        const backgroundEnd = backgroundLeaves.reduce<number | undefined>((latest, span) => {
            const begin = parseTtmlTime(attributeByLocalName(span, "begin"), frameRate);
            const end = resolveTtmlEnd(span, begin, frameRate);
            return end === undefined ? latest : Math.max(latest ?? end, end);
        }, undefined);
        foundWordTiming = true;
        lines.push({
            startMs: paragraphStart ?? words[0]?.startMs,
            endMs: maxDefined(paragraphEnd, words.at(-1)?.endMs, backgroundEnd),
            words,
        });
    }

    if (lines.length === 0) throw new Error("No TTML lyric paragraphs were found");
    return { sourceFormat: "ttml", timingMode: foundWordTiming ? "word" : "line", metadata, lines };
};

export const parseSrt = (source: string): AdvancedLyricsDocument => {
    const lines: AdvancedLyricLine[] = [];
    const blocks = normalizeLineEndings(source).trim().split(/\n{2,}/u);
    const timing = /^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})(?:\s+.*)?$/u;

    for (const block of blocks) {
        const rows = block.split("\n");
        const timingIndex = rows.findIndex((row) => timing.test(row.trim()));
        if (timingIndex === -1) continue;
        const match = timing.exec(rows[timingIndex].trim())!;
        const startMs = srtPartsToMs(match.slice(1, 5));
        const endMs = srtPartsToMs(match.slice(5, 9));
        const text = rows.slice(timingIndex + 1).join("\n");
        lines.push({ startMs, endMs, words: [{ text }] });
    }
    if (lines.length === 0) throw new Error("No SRT cues were found");
    return { sourceFormat: "srt", timingMode: "line", metadata: {}, lines };
};

export const parseLyricBytes = (fileName: string, bytes: Uint8Array): AdvancedLyricsDocument => {
    const extension = fileName.toLowerCase().match(/\.([^.]+)$/u)?.[1];
    if (extension === "krc" || startsWithBytes(bytes, KRC_MAGIC)) return parseKrc(bytes);
    const source = decodeTextBytes(bytes);
    const trimmed = source.trimStart();
    if (/^\[\d+,\d+\](?:<\d+,\d+,-?\d+>.*)?\r?$/mu.test(source)) return parseKrc(source);
    if (extension === "ttml" || /^<\?xml|^<tt(?:\s|>)/iu.test(trimmed)) return parseTtml(source);
    if (extension === "srt" || /\d{1,2}:\d{2}:\d{2}[,.]\d{3}\s*-->/u.test(source)) return parseSrt(source);
    return parseEnhancedLrc(source);
};

export const decodeTextBytes = (bytes: Uint8Array): string => {
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
        return new TextDecoder("utf-8").decode(bytes.subarray(3));
    }
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
        return new TextDecoder("utf-16le").decode(bytes.subarray(2));
    }
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
        const swapped = bytes.subarray(2).slice();
        for (let index = 0; index + 1 < swapped.length; index += 2) {
            [swapped[index], swapped[index + 1]] = [swapped[index + 1], swapped[index]];
        }
        return new TextDecoder("utf-16le").decode(swapped);
    }
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        try {
            return new TextDecoder("gb18030", { fatal: true }).decode(bytes);
        } catch {
            return new TextDecoder("utf-8").decode(bytes);
        }
    }
};

export const toLineLrc = (document: AdvancedLyricsDocument, fixed: Fixed = 3): string => {
    const output = metadataLines(document.metadata);
    for (const line of document.lines) {
        const text = displayLineText(line);
        output.push(line.startMs === undefined ? text : `${formatLrcTimestamp(line.startMs, fixed)}${text}`);
    }
    return output.join("\r\n");
};

export const toLineTimedDocument = (document: AdvancedLyricsDocument): AdvancedLyricsDocument => ({
    ...document,
    timingMode: "line",
    lines: document.lines.map((line) => ({
        startMs: line.startMs,
        endMs: line.endMs,
        words: [{ text: displayLineText(line) }],
    })),
});

export const exportLineLyrics = (
    document: AdvancedLyricsDocument,
    format: LineLyricExportFormat,
    fixed: Fixed = 3,
): string => {
    if (document.lines.length === 0) throw new Error("No lyric lines were found");
    if (
        (format === "srt" || format === "ttml")
        && document.lines.some((line) => displayLineText(line).trim() && line.startMs === undefined)
    ) {
        throw new Error("Timed line output requires a timestamp on every non-empty line");
    }
    const lineDocument = toLineTimedDocument(document);
    switch (format) {
        case "lrc":
            return toLineLrc(lineDocument, fixed);
        case "srt":
            return toSrt(lineDocument);
        case "ttml":
            return toTtml(lineDocument);
        case "txt":
            return lineDocument.lines.map(displayLineText).join("\r\n");
    }
};

export const toEnhancedLrc = (document: AdvancedLyricsDocument, fixed: Fixed = 3): string => {
    const output = metadataLines(document.metadata);
    for (const line of document.lines) {
        const lineTag = line.startMs === undefined ? "" : formatLrcTimestamp(line.startMs, fixed);
        if (document.timingMode !== "word") {
            output.push(lineTag + displayLineText(line));
            continue;
        }
        let content = "";
        for (const word of line.words) {
            if (word.startMs !== undefined) content += formatLrcTimestamp(word.startMs, fixed, "angle");
            content += word.text.replace(/\r?\n/gu, " ");
        }
        const finalEnd = line.endMs ?? [...line.words].reverse().find((word) => word.endMs !== undefined)?.endMs;
        if (finalEnd !== undefined) content += formatLrcTimestamp(finalEnd, fixed, "angle");
        output.push(lineTag + content);
    }
    return output.join("\r\n");
};

export const toKrc = (document: AdvancedLyricsDocument): Uint8Array => {
    const output = metadataLines(document.metadata, false);
    const resolved = resolveLineRanges(document.lines);
    for (const [lineIndex, line] of document.lines.entries()) {
        const range = resolved[lineIndex];
        const words = resolveWordRanges(line, range.startMs, range.endMs);
        const content = words.map((word) => {
            const start = Math.max(0, word.startMs - range.startMs);
            const duration = Math.max(0, word.endMs - word.startMs);
            return `<${start},${duration},0>${word.text.replace(/[\r\n]/gu, " ")}`;
        }).join("");
        output.push(`[${range.startMs},${Math.max(0, range.endMs - range.startMs)}]${content}`);
    }
    const compressed = zlibSync(textEncoder.encode(output.join("\r\n")), { level: 9 });
    const encrypted = compressed.map((value, index) => value ^ KRC_XOR_KEY[index % KRC_XOR_KEY.length]);
    const result = new Uint8Array(KRC_MAGIC.length + encrypted.length);
    result.set(KRC_MAGIC);
    result.set(encrypted, KRC_MAGIC.length);
    return result;
};

export const toSrt = (document: AdvancedLyricsDocument): string => {
    const resolved = resolveLineRanges(document.lines);
    const output: string[] = [];
    let sequence = 1;
    for (const [index, line] of document.lines.entries()) {
        const text = lineText(line).trim().replace(/\r\n|\r|\n/gu, "\r\n");
        if (!text) continue;
        const range = resolved[index];
        output.push(sequence.toString(), `${formatSrtTime(range.startMs)} --> ${formatSrtTime(range.endMs)}`, text, "");
        sequence += 1;
    }
    return output.join("\r\n");
};

export const toTtml = (document: AdvancedLyricsDocument): string => {
    const resolved = resolveLineRanges(document.lines);
    const timing = document.timingMode === "word" ? "Word" : "Line";
    const metadata = Object.entries(document.metadata)
        .map(([name, value]) => `      <ttm:desc ttm:role="${escapeXml(name)}">${escapeXml(value)}</ttm:desc>`)
        .join("\n");
    const body = document.lines.map((line, lineIndex) => {
        const range = resolved[lineIndex];
        if (document.timingMode !== "word") {
            return `        <p begin="${formatTtmlTime(range.startMs)}" end="${formatTtmlTime(range.endMs)}">${
                escapeXml(lineText(line))
            }</p>`;
        }
        const words = resolveWordRanges(line, range.startMs, range.endMs);
        const spans = words.map((word) =>
            `<span begin="${formatTtmlTime(word.startMs)}" end="${formatTtmlTime(word.endMs)}">${
                escapeXml(word.text)
            }</span>`
        ).join("");
        return `        <p begin="${formatTtmlTime(range.startMs)}" end="${formatTtmlTime(range.endMs)}">${spans}</p>`;
    }).join("\n");
    return `<?xml version="1.0" encoding="UTF-8"?>\n<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" xmlns:itunes="http://music.apple.com/lyric-ttml-internal" itunes:timing="${timing}">\n  <head>\n    <metadata>\n${metadata}\n    </metadata>\n  </head>\n  <body>\n    <div>\n${body}\n    </div>\n  </body>\n</tt>\n`;
};

export const serializeLyrics = (
    document: AdvancedLyricsDocument,
    format: ExportLyricFormat,
    fixed: Fixed = 3,
): string | Uint8Array => {
    switch (format) {
        case "lrc":
            return toLineLrc(document, fixed);
        case "enhanced-lrc":
            return toEnhancedLrc(document, fixed);
        case "krc":
            return toKrc(document);
        case "ttml":
            return toTtml(document);
        case "srt":
            return toSrt(document);
    }
};

export const tokenizeLyricText = (text: string): readonly TimedWord[] => {
    if (!text) return [{ text: "" }];
    const lexicalPieces = text.match(
        /[\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]+|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[\p{L}\p{N}\p{M}]+(?:['’ʼ-][\p{L}\p{N}\p{M}]+)*|[^\p{L}\p{N}\p{M}\s]|\s+/gu,
    ) || [text];
    const pieces = lexicalPieces.flatMap((piece) =>
        /^[\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]+$/u.test(piece)
            ? segmentDictionaryScript(piece) || [piece]
            : [piece]
    );
    const words: TimedWord[] = [];
    let pendingSpace = false;
    let prefix = "";
    for (const piece of pieces) {
        if (/^\s+$/u.test(piece)) {
            if (words.length > 0) pendingSpace = true;
            continue;
        }
        if (/^[^\p{L}\p{N}\p{M}\s]+$/u.test(piece)) {
            const previousText = words.at(-1)?.text.trimEnd() || "";
            const opensNext = /^[([{（［｛“‘《「『【]/u.test(piece)
                || (/^["']/u.test(piece)
                    && (words.length === 0 || pendingSpace || /[:：([{（［｛《「『【]$/u.test(previousText)));
            if (opensNext) {
                prefix += `${pendingSpace && words.length > 0 ? " " : ""}${piece}`;
            } else {
                const previous = words.at(-1);
                if (previous) words[words.length - 1] = { ...previous, text: previous.text.trimEnd() + piece };
                else prefix += piece;
            }
            pendingSpace = false;
            continue;
        }
        if (pendingSpace && words.length > 0) {
            const previous = words.at(-1);
            words[words.length - 1] = { ...previous!, text: previous!.text.trimEnd() + " " };
        }
        words.push({ text: prefix + piece });
        prefix = "";
        pendingSpace = false;
    }
    if (prefix) {
        const previous = words.at(-1);
        if (previous) words[words.length - 1] = { ...previous, text: previous.text + prefix };
        else words.push({ text: prefix });
    }
    return words;
};

const segmentDictionaryScript = (text: string): string[] | null => {
    const Segmenter = (Intl as unknown as {
        Segmenter?: new(locale?: string | string[], options?: { granularity: "word" }) => {
            segment: (value: string) => Iterable<{ segment: string }>;
        };
    }).Segmenter;
    if (!Segmenter) return null;
    return Array.from(new Segmenter(undefined, { granularity: "word" }).segment(text), (part) => part.segment);
};

export const createWordTimedDocument = (
    lines: readonly { readonly text: string; readonly time?: number }[],
    metadata: ReadonlyMap<string, string>,
    existing: AdvancedLyricsDocument | null = null,
): AdvancedLyricsDocument => ({
    sourceFormat: existing?.sourceFormat === "krc" || existing?.sourceFormat === "ttml"
        ? existing.sourceFormat
        : "enhanced-lrc",
    timingMode: "word",
    metadata: Object.fromEntries(metadata),
    lines: lines.map((line, index) => {
        const current = existing?.lines[index];
        const text = line.text;
        if (current && displayLineText(current) === text) {
            const nextStart = line.time === undefined ? current.startMs : Math.round(line.time * 1000);
            const lineWithCurrentWords = current.words.every((word) =>
                    word.startMs === undefined && word.endMs === undefined
                )
                ? { ...current, words: tokenizeLyricText(text) }
                : current;
            return moveLineToStart(lineWithCurrentWords, nextStart);
        }
        return {
            startMs: line.time === undefined ? undefined : Math.round(line.time * 1000),
            words: tokenizeLyricText(text),
        };
    }),
});

export const reconcileAdvancedDocument = (
    document: AdvancedLyricsDocument | null,
    lines: readonly { readonly text: string; readonly time?: number }[],
    metadata: ReadonlyMap<string, string>,
): AdvancedLyricsDocument | null => {
    if (!document) return null;
    const nextMetadata = Object.fromEntries(metadata);
    const nextLines = lines.map((line, index) => {
        const current = document.lines[index];
        const startMs = line.time === undefined ? undefined : Math.round(line.time * 1000);
        if (current && displayLineText(current) === line.text) {
            return current.startMs === startMs ? current : moveLineToStart(current, startMs);
        }
        return {
            startMs,
            words: document.timingMode === "word" ? tokenizeLyricText(line.text) : [{ text: line.text }],
        };
    });
    if (
        recordsEqual(document.metadata, nextMetadata)
        && nextLines.length === document.lines.length
        && nextLines.every((line, index) => line === document.lines[index])
    ) {
        return document;
    }
    return {
        ...document,
        metadata: nextMetadata,
        lines: nextLines,
    };
};

export const documentToBasicLyrics = (document: AdvancedLyricsDocument): readonly {
    readonly text: string;
    readonly time?: number;
}[] =>
    document.lines.map((line) => ({
        text: displayLineText(line),
        ...(line.startMs === undefined ? {} : { time: line.startMs / 1000 }),
    }));

export type WordTimingIssue = "invalid" | "duplicate" | "backwards";

export const wordTimingIssueAt = (
    document: AdvancedLyricsDocument,
    lineIndex: number,
    wordIndex: number,
): WordTimingIssue | null => {
    const word = document.lines[lineIndex]?.words[wordIndex];
    if (!word || word.startMs === undefined) return null;
    const previous = previousTimedWord(document, lineIndex, wordIndex);
    if (previous?.startMs !== undefined) {
        if (word.startMs === previous.startMs) return "duplicate";
        if (word.startMs < previous.startMs) return "backwards";
    }
    if (word.endMs !== undefined && word.endMs < word.startMs) return "invalid";
    return null;
};

const previousTimedWord = (
    document: AdvancedLyricsDocument,
    lineIndex: number,
    wordIndex: number,
): TimedWord | undefined => {
    for (let line = lineIndex; line >= 0; line -= 1) {
        const words = document.lines[line]?.words || [];
        for (let word = line === lineIndex ? wordIndex - 1 : words.length - 1; word >= 0; word -= 1) {
            if (words[word].startMs !== undefined) return words[word];
        }
    }
    return undefined;
};

const normalizeLineEndings = (source: string) => source.replace(/^\uFEFF/u, "").replace(/\r\n|\r/gu, "\n");

const recordsEqual = (left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean => {
    const leftEntries = Object.entries(left);
    const rightEntries = Object.entries(right);
    return leftEntries.length === rightEntries.length
        && leftEntries.every(([key, value]) => right[key] === value);
};

const moveLineToStart = (line: AdvancedLyricLine, startMs: number | undefined): AdvancedLyricLine => {
    if (line.startMs === undefined || startMs === undefined || line.startMs === startMs) return { ...line, startMs };
    const offset = startMs - line.startMs;
    return {
        ...line,
        startMs,
        endMs: line.endMs === undefined ? undefined : Math.max(0, line.endMs + offset),
        words: line.words.map((word) => ({
            ...word,
            startMs: word.startMs === undefined ? undefined : Math.max(0, word.startMs + offset),
            endMs: word.endMs === undefined ? undefined : Math.max(0, word.endMs + offset),
        })),
    };
};

const startsWithBytes = (input: Uint8Array, prefix: Uint8Array): boolean =>
    input.length >= prefix.length && prefix.every((value, index) => input[index] === value);

const localName = (node: Pick<Node, "nodeName"> & { localName?: string | null }): string =>
    (node.localName || node.nodeName.split(":").at(-1) || "").toLowerCase();

const allElements = (root: Document | Element): Element[] => Array.from(root.getElementsByTagName("*"));

const attributeByLocalName = (element: Element, name: string): string => {
    const direct = element.getAttribute(name);
    if (direct !== null) return direct;
    for (const attribute of Array.from(element.attributes)) {
        if (localName(attribute) === name.toLowerCase()) return attribute.value;
    }
    return "";
};

const parseTtmlTime = (value: string, frameRate: number): number | undefined => {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const iso = /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/iu.exec(trimmed);
    if (iso) {
        return Math.round((Number(iso[1] || 0) * 3600 + Number(iso[2] || 0) * 60 + Number(iso[3] || 0)) * 1000);
    }
    const unit = /^(\d+(?:\.\d+)?)(ms|s|m|h|f)$/iu.exec(trimmed);
    if (unit) {
        const multiplier = {
            ms: 1,
            s: 1000,
            m: 60_000,
            h: 3_600_000,
            f: 1000 / frameRate,
        }[unit[2].toLowerCase() as "ms" | "s" | "m" | "h" | "f"];
        return Math.round(Number(unit[1]) * multiplier);
    }
    const parts = trimmed.split(":");
    if (parts.length === 4) {
        return Math.round(
            (Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]) + Number(parts[3]) / frameRate) * 1000,
        );
    }
    return parseFlexibleTimestamp(trimmed);
};

const resolveTtmlEnd = (element: Element, startMs: number | undefined, frameRate: number): number | undefined => {
    const end = parseTtmlTime(attributeByLocalName(element, "end"), frameRate);
    if (end !== undefined) return end;
    const duration = parseTtmlTime(attributeByLocalName(element, "dur"), frameRate);
    return startMs !== undefined && duration !== undefined ? startMs + duration : undefined;
};

const leafTimedSpans = (paragraph: Element): Element[] =>
    allElements(paragraph).filter((element) =>
        localName(element) === "span"
        && Boolean(attributeByLocalName(element, "begin"))
        && !allElements(element).some((descendant) =>
            localName(descendant) === "span" && Boolean(attributeByLocalName(descendant, "begin"))
        )
    );

const hasBackgroundAncestor = (element: Element, paragraph: Element): boolean => {
    let parent = element.parentNode;
    while (parent && parent !== paragraph) {
        if (parent.nodeType === 1 && attributeByLocalName(parent as Element, "role") === "x-bg") return true;
        parent = parent.parentNode;
    }
    return attributeByLocalName(element, "role") === "x-bg";
};

const cleanXmlText = (text: string): string => text.replace(/[\r\n\t]/gu, "");

const tailText = (element: Element, paragraph: Element): string => {
    let current: Node | null = element;
    while (current && current !== paragraph) {
        const sibling = current.nextSibling;
        if (sibling?.nodeType === 3) {
            const value = sibling.nodeValue || "";
            return /[\r\n]/u.test(value) && !value.trim() ? "" : cleanXmlText(value);
        }
        if (sibling?.nodeType === 1) return "";
        current = current.parentNode;
    }
    return "";
};

const leadingText = (paragraph: Element): string => {
    const first = paragraph.firstChild;
    if (!first || first.nodeType !== 3) return "";
    const value = first.nodeValue || "";
    return /[\r\n]/u.test(value) && !value.trim() ? "" : cleanXmlText(value);
};

const readTtmlMetadata = (document: Document): Record<string, string> => {
    const metadata: Record<string, string> = {};
    for (const element of allElements(document)) {
        const name = localName(element);
        if (!["title", "agent", "desc"].includes(name)) continue;
        const value = cleanXmlText(element.textContent || "").trim();
        if (!value) continue;
        const role = attributeByLocalName(element, "role");
        if (name === "title") metadata.ti = value;
        else if (name === "agent") metadata.ar ||= value;
        else if (role && !metadata[role]) metadata[role] = value;
    }
    return metadata;
};

const maxDefined = (...values: (number | undefined)[]): number | undefined => {
    const defined = values.filter((value): value is number => value !== undefined);
    return defined.length > 0 ? Math.max(...defined) : undefined;
};

const srtPartsToMs = (parts: string[]): number =>
    Number(parts[0]) * 3_600_000 + Number(parts[1]) * 60_000 + Number(parts[2]) * 1000
    + Number(parts[3].padEnd(3, "0").slice(0, 3));

const metadataLines = (metadata: Readonly<Record<string, string>>, spaced = true): string[] =>
    Object.entries(metadata).filter(([, value]) => value).map(([name, value]) =>
        `[${name}:${spaced ? " " : ""}${value}]`
    );

interface ResolvedRange {
    readonly startMs: number;
    readonly endMs: number;
}

const resolveLineRanges = (lines: readonly AdvancedLyricLine[]): ResolvedRange[] => {
    let previousEnd = 0;
    return lines.map((line, index) => {
        const startMs = Math.max(0, Math.round(line.startMs ?? previousEnd));
        const nextStart = lines.slice(index + 1).find((candidate) => candidate.startMs !== undefined)?.startMs;
        const wordEnd = [...line.words].reverse().find((word) => word.endMs !== undefined)?.endMs;
        const endMs = Math.max(startMs + 1, Math.round(line.endMs ?? wordEnd ?? nextStart ?? startMs + 2000));
        previousEnd = endMs;
        return { startMs, endMs };
    });
};

interface ResolvedWord {
    readonly text: string;
    readonly startMs: number;
    readonly endMs: number;
}

const resolveWordRanges = (line: AdvancedLyricLine, lineStart: number, lineEnd: number): ResolvedWord[] => {
    let previousEnd = lineStart;
    return line.words.map((word, index) => {
        const startMs = Math.max(lineStart, Math.round(word.startMs ?? previousEnd));
        const nextStart = line.words.slice(index + 1).find((candidate) => candidate.startMs !== undefined)?.startMs;
        const endMs = Math.max(startMs, Math.min(lineEnd, Math.round(word.endMs ?? nextStart ?? lineEnd)));
        previousEnd = endMs;
        return { text: word.text, startMs, endMs };
    });
};

const formatSrtTime = (milliseconds: number): string => {
    const safe = Math.max(0, Math.round(milliseconds));
    const hours = Math.floor(safe / 3_600_000);
    const minutes = Math.floor(safe % 3_600_000 / 60_000);
    const seconds = Math.floor(safe % 60_000 / 1000);
    const fraction = safe % 1000;
    return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${
        seconds.toString().padStart(2, "0")
    },${fraction.toString().padStart(3, "0")}`;
};

const formatTtmlTime = (milliseconds: number): string => `${(Math.max(0, milliseconds) / 1000).toFixed(3)}s`;

const escapeXml = (value: string): string =>
    value
        .replace(/&/gu, "&amp;")
        .replace(/</gu, "&lt;")
        .replace(/>/gu, "&gt;")
        .replace(/"/gu, "&quot;")
        .replace(/'/gu, "&apos;");
