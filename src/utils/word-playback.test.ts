import { describe, expect, it } from "vitest";
import { parseEnhancedLrc } from "./advanced-lyrics.js";
import { wordsAtTime } from "./word-playback.js";

describe("overlapping word playback", () => {
    const lines = parseEnhancedLrc([
        "[00:05]<00:05>Main <00:08>voice<00:12>",
        "[00:06]<00:06>Harmony <00:09>voice<00:11>",
        "[00:05]<00:05>Echo<00:13>",
        "[00:03]<00:03>Earlier<00:06>",
    ].join("\n")).lines;

    it("highlights all active voices, including equal starts and unsorted lines", () => {
        expect(wordsAtTime(lines, 5000)).toEqual([
            { lineIndex: 0, wordIndex: 0 },
            { lineIndex: 2, wordIndex: 0 },
            { lineIndex: 3, wordIndex: 0 },
        ]);
        expect(wordsAtTime(lines, 8500)).toEqual([
            { lineIndex: 0, wordIndex: 1 },
            { lineIndex: 1, wordIndex: 0 },
            { lineIndex: 2, wordIndex: 0 },
        ]);
    });

    it("stops each voice at its own end without leaving a stale highlighted word", () => {
        expect(wordsAtTime(lines, 11000)).toEqual([{ lineIndex: 0, wordIndex: 1 }, { lineIndex: 2, wordIndex: 0 }]);
        expect(wordsAtTime(lines, 12000)).toEqual([{ lineIndex: 2, wordIndex: 0 }]);
        expect(wordsAtTime(lines, 13000)).toEqual([]);
        expect(wordsAtTime(lines, 0)).toEqual([]);
    });

    it("uses the next word or later line only when an explicit end is missing", () => {
        const partial = parseEnhancedLrc("[00:05]<00:05>A <00:07>B\n[00:03]<00:03>earlier\n[00:10]next");
        expect(wordsAtTime(partial.lines, 6000)).toEqual([{ lineIndex: 0, wordIndex: 0 }]);
        expect(wordsAtTime(partial.lines, 9500)).toEqual([{ lineIndex: 0, wordIndex: 1 }]);
        expect(wordsAtTime(partial.lines, 10000)).toEqual([]);
    });
});
