import type { WordCursor } from "../hooks/useAdvancedLyrics.js";
import type { AdvancedLyricLine } from "./advanced-lyrics.js";

export interface IndexedPlaybackWord {
    readonly lineIndex: number;
    readonly wordIndex: number;
    readonly startMs: number;
    readonly endMs?: number;
}

export const buildWordPlaybackIndex = (lines: readonly AdvancedLyricLine[]): readonly IndexedPlaybackWord[] => {
    const uniqueStarts = Array.from(
        new Set(lines.map((line) => line.startMs).filter((start): start is number => start !== undefined)),
    ).sort((left, right) => left - right);

    const nextGreaterLineStart = (startMs: number): number | undefined => {
        let low = 0;
        let high = uniqueStarts.length;
        while (low < high) {
            const mid = (low + high) >>> 1;
            if (uniqueStarts[mid] <= startMs) low = mid + 1;
            else high = mid;
        }
        return uniqueStarts[low];
    };

    const indexed: IndexedPlaybackWord[] = [];
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const line = lines[lineIndex];
        const inferredLineEnd = line.startMs === undefined || line.endMs !== undefined
                || line.words.at(-1)?.endMs !== undefined
            ? undefined
            : nextGreaterLineStart(line.startMs);
        let nextWordStart: number | undefined;
        const lineItems: IndexedPlaybackWord[] = [];
        for (let wordIndex = line.words.length - 1; wordIndex >= 0; wordIndex -= 1) {
            const word = line.words[wordIndex];
            if (word.startMs === undefined) continue;
            const endMs = word.endMs ?? nextWordStart ?? line.endMs ?? inferredLineEnd;
            lineItems.push({ lineIndex, wordIndex, startMs: word.startMs, endMs });
            nextWordStart = word.startMs;
        }
        for (let i = lineItems.length - 1; i >= 0; i -= 1) {
            indexed.push(lineItems[i]);
        }
    }
    return indexed;
};

export const wordsAtTimeFromIndex = (
    indexed: readonly IndexedPlaybackWord[],
    timeMs: number,
): readonly WordCursor[] => {
    const playing: WordCursor[] = [];
    for (let i = 0; i < indexed.length; i += 1) {
        const item = indexed[i];
        if (item.startMs <= timeMs && (item.endMs === undefined || timeMs < item.endMs)) {
            playing.push({ lineIndex: item.lineIndex, wordIndex: item.wordIndex });
        }
    }
    return playing;
};

export const wordsAtTime = (lines: readonly AdvancedLyricLine[], timeMs: number): readonly WordCursor[] =>
    wordsAtTimeFromIndex(buildWordPlaybackIndex(lines), timeMs);
