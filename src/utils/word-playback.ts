import type { WordCursor } from "../hooks/useAdvancedLyrics.js";
import type { AdvancedLyricLine } from "./advanced-lyrics.js";

export const wordsAtTime = (lines: readonly AdvancedLyricLine[], timeMs: number): readonly WordCursor[] => {
    const playing: WordCursor[] = [];
    for (const [lineIndex, line] of lines.entries()) {
        const inferredLineEnd = line.startMs === undefined || line.endMs !== undefined
                || line.words.at(-1)?.endMs !== undefined
            ? undefined
            : lines.reduce<number | undefined>(
                (next, candidate) =>
                    candidate.startMs !== undefined && candidate.startMs > line.startMs!
                        ? Math.min(next ?? candidate.startMs, candidate.startMs)
                        : next,
                undefined,
            );
        for (const [wordIndex, word] of line.words.entries()) {
            if (word.startMs === undefined || word.startMs > timeMs) continue;
            const end = word.endMs
                ?? line.words.slice(wordIndex + 1).find((candidate) => candidate.startMs !== undefined)?.startMs
                ?? line.endMs ?? inferredLineEnd;
            if (end === undefined || timeMs < end) playing.push({ lineIndex, wordIndex });
        }
    }
    return playing;
};
