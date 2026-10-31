import { type IFormatOptions, type ILyric, type State, stringify } from "@lrc-maker/lrc-parser";

export const removeTags = (state: State, options: IFormatOptions): string => {
    let seenContent = false;
    const lyric = state.lyric.filter((line) => {
        const trimmed = line.text.trim();
        const firstContent = !seenContent && trimmed.length > 0;
        if (trimmed) seenContent = true;
        const bracket = getBracketLabel(line.text);
        return !bracket || !(isSectionLabel(bracket, true) || firstContent && isLyricDocumentHeader(bracket));
    }).map((line) => ({ text: line.text }));
    return stringify({ info: new Map(), lyric }, options);
};

export const removeEmptyLines = (state: State, options: IFormatOptions): string =>
    stringify(
        {
            info: state.info,
            lyric: state.lyric.filter((line) => line.text.trim().length > 0),
        },
        options,
    );

export const transformTimes = (
    state: State,
    multiplier: number,
    constantMs: number,
    options: IFormatOptions,
    startFromSeconds?: number,
): string => {
    const a = Number.isFinite(multiplier) ? multiplier : 1;
    const c = Number.isFinite(constantMs) ? constantMs / 1000 : 0;
    const threshold = startFromSeconds !== undefined && Number.isFinite(startFromSeconds) && startFromSeconds > 0
        ? startFromSeconds
        : undefined;
    const lyric = state.lyric.map((line) => {
        if (line.time === undefined) return line;
        if (threshold !== undefined && line.time < threshold) return line;
        return { ...line, time: Math.max(0, a * line.time + c) };
    });
    return stringify({ info: state.info, lyric }, options);
};

export type SplitTranslationTarget = "both" | "original" | "translation";

export interface SplitTranslationResult {
    text: string;
    originalText: string;
    translationText: string;
    matchedCount: number;
}

export const splitTranslationWithStats = (
    state: State,
    expression: RegExp,
    options: IFormatOptions,
    target: SplitTranslationTarget = "both",
): SplitTranslationResult => {
    let matchedCount = 0;
    const [original, translation] = state.lyric.reduce(
        ([left, right], line) => {
            const match = expression.exec(line.text);
            expression.lastIndex = 0;
            if (match && match.length >= 3) {
                matchedCount += 1;
                left.push({ ...line, text: match[1] });
                right.push({ ...line, text: match[2] });
            } else {
                left.push(line);
                right.push(line);
            }
            return [left, right];
        },
        [[], []] as [ILyric[], ILyric[]],
    );

    const originalText = stringify({ info: state.info, lyric: original }, options);
    const translationText = stringify({ info: state.info, lyric: translation }, options);
    const text = target === "original"
        ? originalText
        : target === "translation"
        ? translationText
        : `${originalText}\r\n\r\n\r\n${translationText}`;

    return {
        text,
        originalText,
        translationText,
        matchedCount,
    };
};

export const splitTranslation = (
    state: State,
    expression: RegExp,
    options: IFormatOptions,
    target: SplitTranslationTarget = "both",
): string => splitTranslationWithStats(state, expression, options, target).text;

export type OverwriteOutputMode = "replace" | "inline" | "dual-line";
export type OverwriteAlignMode = "smart" | "strict";
export type OverwriteFallbackMode = "keep" | "empty";
export type OverwriteRowKind = "lyric" | "empty" | "credit" | "section" | "skipped";

export interface OverwriteLyricsOptions {
    outputMode?: OverwriteOutputMode;
    inlineTemplate?: string;
    alignMode?: OverwriteAlignMode;
    preserveCredits?: boolean;
    ignoreBlankLines?: boolean;
    unmatchedFallback?: OverwriteFallbackMode;
    skippedLineIndices?: ReadonlySet<number>;
    forcedLyricLineIndices?: ReadonlySet<number>;
}

export interface OverwritePlanRow {
    lineIndex: number;
    slotIndex: number | null;
    time?: number;
    sourceText: string;
    replacementText: string;
    matched: boolean;
    kind: OverwriteRowKind;
}

export interface OverwritePlan {
    rows: OverwritePlanRow[];
    targetCount: number;
    inputCount: number;
    extraLines: string[];
    firstUnmatchedLineIndex: number | null;
    lyric: ILyric[];
    text: string;
}

const creditRolePattern = new RegExp(
    "^(?:"
        + "作[词詞]|填[词詞]|[词詞]|作曲|谱曲|曲|[编編]曲|制作人?|製作人?|プロデューサー|"
        + "监制|監製|出品|演唱|歌手|歌|原唱|翻唱|和声|和聲|和音|混音|缩混|母带|母帶|录音|錄音|"
        + "吉他|木吉他|电吉他|贝斯|貝斯|鼓|钢琴|鋼琴|键盘|鍵盤|弦乐|弦樂|管乐|管樂|统筹|統籌|企划|企劃|文案|发行|發行|OP|SP|"
        + "[词詞]\\s*[/／]\\s*曲|作[词詞]\\s*[/／]\\s*作曲|"
        + "lyrics?(?:\\s+by)?|lyricist|composed(?:\\s+by)?|composer|arranged(?:\\s+by)?|arranger|"
        + "produced(?:\\s+by)?|producer|written(?:\\s+by)?|vocals?(?:\\s+by)?|mixed(?:\\s+by)?|mastered(?:\\s+by)?|"
        + "작사|작곡|편곡|보컬|노래"
        + ")\\s*[:：]\\s*\\S+",
    "iu",
);

export const isCreditLine = (text: string): boolean => {
    const trimmed = text.trim();
    if (!trimmed || trimmed.length > 96) return false;
    return creditRolePattern.test(trimmed);
};

export const extractReplacementLines = (
    text: string,
    options?: { alignMode?: OverwriteAlignMode; ignoreBlankLines?: boolean },
): string[] => {
    const cleaned = text.replace(/^\uFEFF/, "");
    if (cleaned.trim() === "") return [];
    const alignMode = options?.alignMode ?? "smart";
    const ignoreBlankLines = options?.ignoreBlankLines ?? (alignMode === "smart");
    const lines = cleaned.replace(/\r\n?/g, "\n").split("\n");
    let seenContent = false;

    const stripped = lines
        .map((line) =>
            line
                .replace(/^(?:\[\s*(?:\d{1,3}:)?\d{1,2}:\d{2}(?:[.:]\d{1,3})?\s*\])+/g, "")
                .replace(/<(?:\d{1,3}:)?\d{1,2}:\d{2}(?:[.:]\d{1,3})?>/g, "")
        )
        .filter((line) =>
            !/^\[(?:ti|title|ar|artist|al|album|au|author|by|offset|length|re|ve|tool):/i.test(line.trim())
        );

    return stripped.filter((line) => {
        const trimmed = line.trim();
        if (alignMode === "smart") {
            const firstContent = !seenContent && trimmed.length > 0;
            if (trimmed) seenContent = true;
            const bracket = getBracketLabel(line);
            if (bracket && (isSectionLabel(bracket, true) || (firstContent && isLyricDocumentHeader(bracket)))) {
                return false;
            }
        }
        if (ignoreBlankLines && trimmed === "") {
            return false;
        }
        return true;
    });
};

const formatInlineBilingual = (sourceText: string, replacementText: string, template: string): string => {
    const cleanSource = sourceText.trim();
    const cleanTrans = replacementText.trim();
    if (!cleanSource) return replacementText;
    if (!cleanTrans || cleanSource === cleanTrans) return sourceText;
    if (template.includes("%orig") || template.includes("%trans")) {
        return template.replace("%orig", cleanSource).replace("%trans", cleanTrans);
    }
    return `${cleanSource}${template}${cleanTrans}`;
};

export const buildOverwritePlan = (
    state: State,
    replacement: string,
    formatOptions: IFormatOptions,
    overwriteOptions: OverwriteLyricsOptions = {},
): OverwritePlan => {
    const outputMode = overwriteOptions.outputMode ?? "replace";
    const inlineTemplate = overwriteOptions.inlineTemplate ?? "%orig / %trans";
    const alignMode = overwriteOptions.alignMode ?? "smart";
    const preserveCredits = overwriteOptions.preserveCredits ?? (alignMode === "smart");
    const ignoreBlankLines = overwriteOptions.ignoreBlankLines ?? (alignMode === "smart");
    const unmatchedFallback = overwriteOptions.unmatchedFallback ?? "keep";
    const skippedSet = overwriteOptions.skippedLineIndices;
    const forcedSet = overwriteOptions.forcedLyricLineIndices;

    const replacementLines = extractReplacementLines(replacement, { alignMode, ignoreBlankLines });
    const rows: OverwritePlanRow[] = [];
    const outputLyric: ILyric[] = [];

    let cursor = 0;
    let seenSourceContent = false;
    let firstUnmatchedLineIndex: number | null = null;

    for (let index = 0; index < state.lyric.length; index += 1) {
        const line = state.lyric[index];
        const sourceText = line.text;
        const trimmed = sourceText.trim();
        const firstContent = !seenSourceContent && trimmed.length > 0;
        if (trimmed) seenSourceContent = true;

        let kind: OverwriteRowKind = "lyric";
        if (skippedSet?.has(index)) {
            kind = "skipped";
        } else if (!forcedSet?.has(index) && alignMode === "smart") {
            const bracket = getBracketLabel(sourceText);
            if (trimmed === "") {
                kind = "empty";
            } else if (bracket && (isSectionLabel(bracket, true) || (firstContent && isLyricDocumentHeader(bracket)))) {
                kind = "section";
            } else if (preserveCredits && isCreditLine(trimmed)) {
                const candidate = replacementLines[cursor];
                if (!candidate || !isCreditLine(candidate)) {
                    kind = "credit";
                }
            }
        }

        if (kind !== "lyric") {
            rows.push({
                lineIndex: index,
                slotIndex: null,
                time: line.time,
                sourceText,
                replacementText: "",
                matched: false,
                kind,
            });
            if (kind === "empty") {
                outputLyric.push({ ...line, text: "" });
            } else if (kind === "section") {
                outputLyric.push({ ...line, text: line.time !== undefined ? "" : sourceText });
            } else {
                outputLyric.push({ ...line, text: sourceText });
            }
            continue;
        }

        const slotIndex = cursor;
        cursor += 1;
        const matched = slotIndex < replacementLines.length;
        const replacementText = matched ? replacementLines[slotIndex] : "";
        if (!matched && firstUnmatchedLineIndex === null) {
            firstUnmatchedLineIndex = index;
        }

        rows.push({
            lineIndex: index,
            slotIndex,
            time: line.time,
            sourceText,
            replacementText,
            matched,
            kind: "lyric",
        });

        if (replacementLines.length === 0 && unmatchedFallback === "keep") {
            outputLyric.push({ ...line, text: sourceText });
            continue;
        }

        if (outputMode === "replace") {
            const nextText = matched
                ? replacementText
                : unmatchedFallback === "keep"
                ? sourceText
                : "";
            outputLyric.push({ ...line, text: nextText });
        } else if (outputMode === "inline") {
            const nextText = matched && replacementText.trim() !== ""
                ? formatInlineBilingual(sourceText, replacementText, inlineTemplate)
                : sourceText;
            outputLyric.push({ ...line, text: nextText });
        } else {
            outputLyric.push({ ...line, text: sourceText });
            if (matched && replacementText.trim() !== "" && replacementText.trim() !== trimmed) {
                outputLyric.push({ ...line, text: replacementText });
            }
        }
    }

    const extraLines = cursor < replacementLines.length ? replacementLines.slice(cursor) : [];

    return {
        rows,
        targetCount: cursor,
        inputCount: replacementLines.length,
        extraLines,
        firstUnmatchedLineIndex,
        lyric: outputLyric,
        text: stringify({ info: state.info, lyric: outputLyric }, formatOptions),
    };
};

export const overwriteLyrics = (
    state: State,
    replacement: string,
    options: IFormatOptions,
    overwriteOptions?: OverwriteLyricsOptions,
): string => {
    if (!overwriteOptions) {
        const translations = normalizeTranslationLines(replacement);
        const lyric = state.lyric.map((line, index) => ({ ...line, text: translations[index] ?? "" }));
        return stringify({ info: state.info, lyric }, options);
    }
    return buildOverwritePlan(state, replacement, options, overwriteOptions).text;
};

export type DuplicateTimestampStrategy = "dedupe-exact" | "merge-inline" | "nudge" | "keep";

export interface TimelineRepairOptions {
    expandMultiTimestamps?: boolean;
    sortChronologically?: boolean;
    duplicateStrategy?: DuplicateTimestampStrategy;
    inlineSeparator?: string;
    trimSpaces?: boolean;
}

export interface TimelineRepairResult {
    text: string;
    expandedCount: number;
    reorderedCount: number;
    duplicateResolvedCount: number;
    lineCount: number;
}

export const repairTimeline = (
    sourceText: string,
    formatOptions: IFormatOptions,
    repairOptions: TimelineRepairOptions = {},
): TimelineRepairResult => {
    const expandMultiTimestamps = repairOptions.expandMultiTimestamps ?? true;
    const sortChronologically = repairOptions.sortChronologically ?? true;
    const duplicateStrategy = repairOptions.duplicateStrategy ?? "dedupe-exact";
    const inlineSeparator = repairOptions.inlineSeparator ?? " / ";
    const trimSpaces = repairOptions.trimSpaces ?? true;

    const rawLines = sourceText.replace(/^\uFEFF/, "").split(/\r\n|\n|\r/u);
    const singleTimeTag = /^\[\s*(\d{1,3}):(\d{1,2}(?:[:.]\d{1,3})?)\s*\]/;
    const infoTag = /^\[\s*(\w{1,6})\s*:(.*?)\]\s*$/;
    const info = new Map<string, string>();

    interface ParsedItem {
        time?: number;
        text: string;
        order: number;
    }

    const items: ParsedItem[] = [];
    let expandedCount = 0;
    let orderCounter = 0;

    const cleanText = (value: string): string => trimSpaces ? value.replace(/^[\s\u3000]+|[\s\u3000]+$/gu, "") : value;

    for (const rawLine of rawLines) {
        if (!rawLine.startsWith("[")) {
            items.push({ text: cleanText(rawLine), order: orderCounter++ });
            continue;
        }

        const extractedTimes: number[] = [];
        let cursor = rawLine;
        while (true) {
            const match = singleTimeTag.exec(cursor);
            if (!match) break;
            const mm = Number.parseInt(match[1], 10);
            const ss = Number.parseFloat(match[2].replace(":", "."));
            extractedTimes.push(mm * 60 + ss);
            cursor = cursor.slice(match[0].length);
            if (!expandMultiTimestamps) break;
        }

        if (extractedTimes.length > 0) {
            if (extractedTimes.length > 1) {
                expandedCount += extractedTimes.length - 1;
            }
            const text = cleanText(cursor);
            for (const time of extractedTimes) {
                items.push({ time, text, order: orderCounter++ });
            }
            continue;
        }

        const infoMatch = infoTag.exec(rawLine);
        if (infoMatch) {
            const value = infoMatch[2].trim();
            if (value !== "") {
                info.set(infoMatch[1], value);
            }
            continue;
        }

        items.push({ text: cleanText(rawLine), order: orderCounter++ });
    }

    let orderedItems = items;
    let reorderedCount = 0;

    if (sortChronologically) {
        let maxTimeSeen = -Infinity;
        for (const item of items) {
            if (item.time !== undefined) {
                if (item.time + 1e-6 < maxTimeSeen) {
                    reorderedCount += 1;
                } else {
                    maxTimeSeen = item.time;
                }
            }
        }

        // Group untimed lines with their surrounding context: leading untimed stay at top,
        // subsequent untimed stay attached immediately after the timed item they followed.
        interface TimedGroup {
            anchorTime: number;
            anchorOrder: number;
            entries: ParsedItem[];
        }
        const leadingUntimed: ParsedItem[] = [];
        const groups: TimedGroup[] = [];

        for (const item of items) {
            if (item.time !== undefined) {
                groups.push({ anchorTime: item.time, anchorOrder: item.order, entries: [item] });
            } else if (groups.length === 0) {
                if (item.text.trim() !== "") {
                    leadingUntimed.push(item);
                }
            } else if (item.text.trim() !== "") {
                groups[groups.length - 1].entries.push(item);
            }
        }

        groups.sort((a, b) => (a.anchorTime - b.anchorTime) || (a.anchorOrder - b.anchorOrder));
        orderedItems = [...leadingUntimed, ...groups.flatMap((group) => group.entries)];
    }

    const scale = 10 ** formatOptions.fixed;
    const step = 1 / scale;
    const toBucket = (time: number): number => Math.round(time * scale);

    const finalLyric: ILyric[] = [];
    let duplicateResolvedCount = 0;

    if (duplicateStrategy === "merge-inline") {
        for (const item of orderedItems) {
            const prev = finalLyric.at(-1);
            if (
                item.time !== undefined
                && prev?.time !== undefined
                && toBucket(item.time) === toBucket(prev.time)
            ) {
                duplicateResolvedCount += 1;
                const left = prev.text.trim();
                const right = item.text.trim();
                if (!right || left === right) {
                    continue;
                }
                if (!left) {
                    prev.text = item.text;
                    continue;
                }
                const existingParts = left.split(inlineSeparator).map((part) => part.trim());
                if (!existingParts.includes(right)) {
                    prev.text = `${left}${inlineSeparator}${right}`;
                }
                continue;
            }
            finalLyric.push(item.time === undefined ? { text: item.text } : { time: item.time, text: item.text });
        }
    } else if (duplicateStrategy === "dedupe-exact") {
        for (const item of orderedItems) {
            const prev = finalLyric.at(-1);
            if (
                item.time !== undefined
                && prev?.time !== undefined
                && toBucket(item.time) === toBucket(prev.time)
                && item.text.trim() === prev.text.trim()
            ) {
                duplicateResolvedCount += 1;
                continue;
            }
            finalLyric.push(item.time === undefined ? { text: item.text } : { time: item.time, text: item.text });
        }
    } else if (duplicateStrategy === "nudge") {
        let lastBucket = -1;
        for (const item of orderedItems) {
            if (item.time === undefined) {
                finalLyric.push({ text: item.text });
                continue;
            }
            let nextTime = item.time;
            let bucket = toBucket(nextTime);
            if (bucket <= lastBucket) {
                duplicateResolvedCount += 1;
                bucket = lastBucket + 1;
                nextTime = Number((bucket * step).toFixed(formatOptions.fixed));
            }
            lastBucket = bucket;
            finalLyric.push({ time: nextTime, text: item.text });
        }
    } else {
        for (const item of orderedItems) {
            finalLyric.push(item.time === undefined ? { text: item.text } : { time: item.time, text: item.text });
        }
    }

    return {
        text: stringify({ info, lyric: finalLyric }, formatOptions),
        expandedCount,
        reorderedCount,
        duplicateResolvedCount,
        lineCount: finalLyric.length,
    };
};

const normalizeTranslationLines = (text: string): string[] => {
    const lines = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
    return lines
        .map((line) => line.replace(/^(?:\[(?:\d{1,3}:)?\d{1,2}:\d{2}(?:[.:]\d{1,3})?\])+/, ""))
        .filter((line) =>
            !/^\[(?:ti|title|ar|artist|al|album|au|author|by|offset|length|re|ve|tool):/i.test(line.trim())
        );
};

const sectionAliases = [
    "instrumental introduction",
    "instrumental interlude",
    "instrumental outro",
    "instrumental intro",
    "instrumental break",
    "background vocals",
    "non-lyrical vocals",
    "spoken word",
    "post-chorus",
    "post chorus",
    "postchorus",
    "pre-chorus",
    "pre chorus",
    "prechorus",
    "post-hook",
    "post hook",
    "posthook",
    "pre-hook",
    "pre hook",
    "prehook",
    "dance break",
    "guitar solo",
    "piano solo",
    "drum solo",
    "vocal break",
    "introduction",
    "instrumental",
    "interlude",
    "breakdown",
    "transition",
    "refrain",
    "chorus",
    "bridge",
    "verse",
    "intro",
    "outro",
    "hook",
    "break",
    "drop",
    "solo",
    "spoken",
    "skit",
    "part",
    "sample",
    "vocals",
    "vocal",
    "choir",
    "orchestra",
    "reprise",
    "buildup",
    "build-up",
    "build up",
    "opening",
    "ending",
    "rap",
    "前副歌",
    "预副歌",
    "后副歌",
    "器乐间奏",
    "器乐前奏",
    "器乐尾奏",
    "前奏",
    "主歌",
    "副歌",
    "桥段",
    "间奏",
    "尾奏",
    "收尾",
    "独奏",
    "说唱",
    "合唱",
    "器乐",
    "念白",
    "过渡",
].sort((left, right) => right.length - left.length);

const metadataKeys = new Set([
    "ti",
    "title",
    "ar",
    "artist",
    "al",
    "album",
    "au",
    "author",
    "by",
    "offset",
    "length",
    "re",
    "ve",
    "tool",
    "encoding",
    "id",
    "hash",
    "sign",
    "language",
    "la",
    "key",
    "tr",
    "translation",
    "translated by",
    "translator",
    "romanization",
    "romaji",
    "翻译",
    "译者",
    "罗马音",
]);

export interface SectionCleanupOptions {
    strictMode: boolean;
    dropEmpty: boolean;
    dropSuggestions: boolean;
}

export interface SectionCleanupResult {
    text: string;
    removed: string[];
    blankRemoved: number;
}

export const stripGeniusSections = (text: string, options: SectionCleanupOptions): SectionCleanupResult => {
    const removed: string[] = [];
    let blankRemoved = 0;
    let seenContent = false;
    const lines = splitLinesWithEndings(text);
    const kept = lines.filter((line) => {
        const trimmed = line.content.trim();
        const firstContent = !seenContent && trimmed.length > 0;
        if (trimmed) seenContent = true;
        const bracket = getBracketLabel(line.content);
        if (
            bracket && (isSectionLabel(bracket, options.strictMode) || firstContent && isLyricDocumentHeader(bracket))
        ) {
            removed.push(trimmed);
            return false;
        }
        if (options.dropSuggestions && /^you might also like$/i.test(trimmed)) {
            removed.push(trimmed);
            return false;
        }
        if (options.dropEmpty && trimmed === "") {
            blankRemoved += 1;
            return false;
        }
        return true;
    });
    return { text: kept.map((line) => line.content + line.eol).join(""), removed, blankRemoved };
};

const getBracketLabel = (line: string): string | null =>
    /^\s*(?:\[|［|【)([^\]］】\r\n]+)(?:\]|］|】)\s*$/u.exec(line)?.[1] || null;

const isLyricDocumentHeader = (label: string): boolean => {
    const value = label
        .normalize("NFKC")
        .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
        .trim();
    const match = /^(.{2,}?)(?:\s+lyrics?|歌[詞词]|가사)$/iu.exec(value);
    return Boolean(match && /[\p{L}\p{N}]/u.test(match[1]));
};

const splitLinesWithEndings = (text: string): Array<{ content: string; eol: string }> => {
    if (!text) return [];
    const parts = text.split(/(\r\n|\n|\r)/);
    const lines: Array<{ content: string; eol: string }> = [];
    for (let index = 0; index < parts.length; index += 2) {
        lines.push({ content: parts[index], eol: parts[index + 1] || "" });
    }
    return lines;
};

const isSectionLabel = (label: string, strictMode: boolean): boolean => {
    const value = label
        .normalize("NFKC")
        .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
        .replace(/[\u2010-\u2015\u2212]/g, "-")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
    if (!value || /^(?:\d{1,3}:)?\d{1,2}:\d{2}(?:[.:]\d{1,3})?$/.test(value)) return false;
    const metadata = /^([^:：]{1,32})\s*[:：]/u.exec(value)?.[1].trim() || "";
    if (metadataKeys.has(metadata)) return false;
    const known = sectionAliases.some((alias) => {
        if (value === alias) return true;
        if (!value.startsWith(alias)) return false;
        let suffix = value.slice(alias.length);
        const cjkNumber = /^[一二三四五六七八九十]+/u.test(suffix);
        if (!suffix || (!/^[\s:()-]/.test(suffix) && !cjkNumber)) return false;
        if (cjkNumber) suffix = ` ${suffix}`;
        return /^(?:\s+(?:\d+|[ivxlcdm]+|[a-z]|one|two|three|four|five|six|seven|eight|nine|ten|[一二三四五六七八九十]+|x\d+|\d+x))*\s*(?::\s*.*|\s+-\s+\S(?:.*\S)?|\([^)\r\n]{1,100}\))?$/i
            .test(suffix);
    });
    return known || (!strictMode && /\p{L}/u.test(value));
};

export interface TracklistOptions {
    keepTitle: boolean;
    stripFeatured: boolean;
}

export interface TracklistResult {
    text: string;
    tracks: number;
    ignored: number;
}

export const cleanGeniusTracklist = (text: string, options: TracklistOptions): TracklistResult => {
    const tracks: Array<{ number: number; title: string }> = [];
    let ignored = 0;
    let pendingNumber: number | null = null;
    let albumTitle = "";
    for (const rawLine of text.split(/\r\n|\n|\r/)) {
        const trimmed = rawLine.trim();
        if (!trimmed) {
            ignored += 1;
            continue;
        }
        const markdown = /^\[([^\]]+)]\([^)]+\)$/.exec(trimmed);
        const label = markdown?.[1].trim() || trimmed;
        const header = /^(.+?)\s+songs$/i.exec(label);
        if (header) {
            albumTitle = header[1].trim();
            ignored += 1;
            continue;
        }
        const numbered = /^(\d+)\.?$/.exec(label);
        if (numbered) {
            const number = Number(numbered[1]);
            if (number === tracks.length + 1) pendingNumber = number;
            else ignored += 1;
            continue;
        }
        if (/^\d+(?:\.\d+)?[km]?$/i.test(label.replace(/,/g, ""))) {
            ignored += 1;
            continue;
        }
        if (pendingNumber !== null || /\s*Lyrics$/i.test(label) || markdown) {
            let title = label.replace(/\s*Lyrics$/i, "").trim();
            if (options.stripFeatured) {
                title = title
                    .replace(/\s+\((?:ft\.?|feat\.?|featuring)\s+[^)]+\)/gi, "")
                    .replace(/\s+\[(?:ft\.?|feat\.?|featuring)\s+[^\]]+\]/gi, "")
                    .trim();
            }
            if (title) {
                tracks.push({ number: pendingNumber || tracks.length + 1, title });
                pendingNumber = null;
                continue;
            }
        }
        ignored += 1;
    }
    const output = tracks.map((track) => `${track.number}. ${track.title}`);
    if (options.keepTitle && albumTitle) output.unshift(albumTitle.toUpperCase());
    return { text: output.join("\n"), tracks: tracks.length, ignored };
};

export interface ReplaceTextOptions {
    find: string;
    replacement: string;
    regex: boolean;
    caseSensitive: boolean;
}

export const replaceText = (
    text: string,
    options: ReplaceTextOptions,
): { text: string; count: number; error?: string } => {
    const find = options.find.trim();
    if (!find) return { text, count: 0 };
    try {
        const pieces = options.regex ? [find] : find.split("|").filter(Boolean).map(escapeRegExp);
        const pattern = new RegExp(options.regex ? find : pieces.join("|"), `g${options.caseSensitive ? "" : "i"}`);
        let count = 0;
        const output = text.replace(pattern, () => {
            count += 1;
            return options.replacement;
        });
        return { text: output, count };
    } catch (error) {
        return { text: "", count: 0, error: error instanceof Error ? error.message : "Invalid regular expression" };
    }
};

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export type LyricsCaseMode = "sentence" | "upper" | "lower" | "words" | "title";

export const convertLyricsCase = (
    text: string,
    mode: LyricsCaseMode,
    lineStart: boolean,
    fixPronoun: boolean,
): string =>
    protectTimestamps(text, (safeText) => {
        let output = safeText;
        if (mode === "upper") output = safeText.toUpperCase();
        if (mode === "lower") output = safeText.toLowerCase();
        if (mode === "words") {
            output = safeText.toLowerCase().replace(/\b([A-Za-z])([A-Za-z'’]*)/g, (_, first, rest) =>
                first.toUpperCase() + rest);
        }
        if (mode === "title") {
            const minor = new Set([
                "a",
                "an",
                "the",
                "and",
                "but",
                "or",
                "for",
                "nor",
                "on",
                "at",
                "to",
                "by",
                "in",
                "of",
                "up",
                "as",
                "so",
                "yet",
                "off",
                "if",
                "per",
                "via",
                "out",
            ]);
            output = safeText.toLowerCase().replace(/\b([A-Za-z][A-Za-z'’]*)\b/g, (word, _inner, offset, fullText) => {
                const before = fullText.slice(0, offset).match(/[A-Za-z][A-Za-z'’]*\b/g) || [];
                const after = fullText.slice(offset + word.length).match(/\b[A-Za-z][A-Za-z'’]*/g) || [];
                return before.length > 0 && after.length > 0 && minor.has(word)
                    ? word
                    : word[0].toUpperCase() + word.slice(1);
            });
        }
        if (mode === "sentence") {
            let capitalize = true;
            output = [...safeText].map((character) => {
                if (/[A-Za-z]/.test(character)) {
                    const result = capitalize ? character.toUpperCase() : character.toLowerCase();
                    capitalize = false;
                    return result;
                }
                if (/[.!?:]/.test(character) || (lineStart && /[\r\n]/.test(character))) {
                    capitalize = true;
                }
                return character;
            }).join("");
        }
        return fixPronoun ? output.replace(/\bi(?=(?:['’](?:m|d|ll|ve|re)\b|\b))/gi, "I") : output;
    });

const protectTimestamps = (text: string, transform: (value: string) => string): string => {
    const timestamps: string[] = [];
    const protectedText = text.replace(/\[(?:\d{1,3}:)?\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]/g, (match) => {
        const token = `\uE000${timestamps.length}\uE001`;
        timestamps.push(match);
        return token;
    });
    return transform(protectedText).replace(/\uE000(\d+)\uE001/g, (_, index) => timestamps[Number(index)]);
};
