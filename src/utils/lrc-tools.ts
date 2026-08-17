import {
    convertTimeToTag,
    formatText,
    type IFormatOptions,
    type ILyric,
    type State,
    stringify,
} from "@lrc-maker/lrc-parser";

export const compressTags = (state: State, options: IFormatOptions): string => {
    const { endOfLine = "\r\n", fixed, spaceEnd, spaceStart } = options;
    const info = [...state.info].map(([name, value]) => `[${name}: ${value}]`);
    const records = new Map<string, number[]>();

    for (const line of state.lyric) {
        if (line.time === undefined) {
            continue;
        }
        const times = records.get(line.text) || [];
        records.set(line.text, [...times, line.time]);
    }

    const lyric = [...records].map(([text, times]) => {
        const tags = times.map((time) => convertTimeToTag(time, fixed)).join("");
        return `${tags}${formatText(text, spaceStart, spaceEnd)}`;
    });
    return [...info, ...lyric].join(endOfLine);
};

export const removeTags = (state: State, options: IFormatOptions): string =>
    stringify(
        {
            info: new Map(),
            lyric: state.lyric.map((line) => ({ text: line.text })),
        },
        options,
    );

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
): string => {
    const a = Number.isFinite(multiplier) ? multiplier : 1;
    const c = Number.isFinite(constantMs) ? constantMs / 1000 : 0;
    const lyric = state.lyric.map((line) =>
        line.time === undefined ? line : { ...line, time: Math.max(0, a * line.time + c) }
    );
    return stringify({ info: state.info, lyric }, options);
};

export const splitTranslation = (state: State, expression: RegExp, options: IFormatOptions): string => {
    const [original, translation] = state.lyric.reduce(
        ([left, right], line) => {
            const match = expression.exec(line.text);
            expression.lastIndex = 0;
            if (match && match.length >= 3) {
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

    return [original, translation]
        .map((lyric) => stringify({ info: state.info, lyric }, options))
        .join("\r\n\r\n\r\n");
};

export const overwriteLyrics = (state: State, replacement: string, options: IFormatOptions): string => {
    const lines = normalizeTranslationLines(replacement);
    const directMapping = lines.length === state.lyric.length;
    const translations = directMapping ? lines.slice() : lines.filter((line) => line.trim().length > 0);
    let translationIndex = 0;
    const lyric = state.lyric.map((line, index) => {
        if (!directMapping && line.text.trim().length === 0) {
            return { ...line, text: "" };
        }
        const text = directMapping ? translations[index] ?? "" : translations[translationIndex++] ?? "";
        return { ...line, text };
    });
    if (!directMapping) {
        lyric.push(...translations.slice(translationIndex).map((text) => ({ text })));
    }
    return stringify({ info: state.info, lyric }, options);
};

const normalizeTranslationLines = (text: string): string[] => {
    const lines = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
    while (lines[0]?.trim() === "") lines.shift();
    while (lines.at(-1)?.trim() === "") lines.pop();
    return lines
        .filter((line) =>
            !/^\[(?:ti|title|ar|artist|al|album|au|author|by|offset|length|re|ve|tool):/i.test(line.trim())
        )
        .map((line) => line.replace(/^(?:\[(?:\d{1,3}:)?\d{1,2}:\d{2}(?:[.:]\d{1,3})?\])+/, ""));
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
    const lines = splitLinesWithEndings(text);
    const kept = lines.filter((line) => {
        const trimmed = line.content.trim();
        const bracket = /^\s*(?:\[|［|【)([^\]］】\r\n]+)(?:\]|］|】)\s*$/u.exec(line.content);
        if (bracket && isSectionLabel(bracket[1], options.strictMode)) {
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
