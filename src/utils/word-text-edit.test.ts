import { describe, expect, it } from "vitest";
import { lineText, parseEnhancedLrc, toEnhancedLrc } from "./advanced-lyrics.js";
import { editWordTimedLine } from "./word-text-edit.js";

const original =
    parseEnhancedLrc("[00:02.40]<00:02.40>It's <00:02.79>been <00:02.97>a <00:03.17>couple <00:03.64>months<00:04.51>")
        .lines[0];
const starts = (line: typeof original) => line.words.map((word) => word.startMs);

describe("sentence text edits with word timing", () => {
    it("inserts untimed words while preserving the surrounding axis", () => {
        const next = editWordTimedLine(original, "It's really been a couple months");
        expect(lineText(next)).toBe("It's really been a couple months");
        expect(starts(next)).toEqual([2400, undefined, 2790, 2970, 3170, 3640]);
        expect(next.words[2].endMs).toBe(original.words[1].endMs);
        expect(next.endMs).toBe(4510);
    });

    it("deletes or replaces whole words without moving untouched timestamps", () => {
        expect(starts(editWordTimedLine(original, "It's couple months"))).toEqual([2400, 3170, 3640]);
        expect(starts(editWordTimedLine(original, "It's been a few months"))).toEqual([
            2400,
            2790,
            2970,
            undefined,
            3640,
        ]);
        expect(starts(original)).toEqual([2400, 2790, 2970, 3170, 3640]);
    });

    it("preserves imported syllable boundaries inside unchanged English words", () => {
        const line = parseEnhancedLrc("[00:01]<00:01>my <00:02>memor<00:03>ies<00:04>").lines[0];
        const next = editWordTimedLine(line, "all my memories");
        expect(next.words.map((word) => word.text)).toEqual(["all ", "my ", "memor", "ies"]);
        expect(starts(next)).toEqual([undefined, 1000, 2000, 3000]);
        expect(editWordTimedLine(line, lineText(line))).toBe(line);
    });

    it("uses the actual edit range to distinguish repeated words", () => {
        const line = parseEnhancedLrc("[00:01]<00:01>no <00:02>no <00:03>no<00:04>").lines[0];
        expect(starts(editWordTimedLine(line, "no no", { start: 0, end: 3 }))).toEqual([2000, 3000]);
        expect(starts(editWordTimedLine(line, "no no", { start: 3, end: 6 }))).toEqual([1000, 3000]);
        expect(starts(editWordTimedLine(line, "no no", { start: 5, end: 8 }))).toEqual([1000, 2000]);
    });

    it("retains timings across punctuation and whitespace edits without changing typed text", () => {
        const line = parseEnhancedLrc("[00:01]<00:01>(\"I <00:02>can't <00:03>see\")<00:04>").lines[0];
        const next = editWordTimedLine(line, "“I  can't see!”");
        expect(lineText(next)).toBe("“I  can't see!”");
        expect(starts(next)).toEqual([1000, 2000, 3000]);
    });

    it("does not retain a word's timing merely because part of its spelling matches", () => {
        const line = parseEnhancedLrc("[00:01]<00:01>cat <00:02>walks<00:03>").lines[0];
        expect(starts(editWordTimedLine(line, "cats walks"))).toEqual([undefined, 2000]);
        const joined = editWordTimedLine(line, "catwalks");
        expect(joined.words.every((word) => word.startMs === undefined)).toBe(true);
    });

    it("keeps timing for capitalization and equivalent apostrophes", () => {
        const line = parseEnhancedLrc("[00:01]<00:01>I <00:02>don't <00:03>know<00:04>").lines[0];
        for (const text of ["I DON’T KNOW", "i donʼt know"]) {
            const next = editWordTimedLine(line, text);
            expect(lineText(next)).toBe(text);
            expect(starts(next)).toEqual([1000, 2000, 3000]);
        }
    });

    it("keeps mixed-script timing and emoji intact", () => {
        const line = parseEnhancedLrc("[00:01]<00:01>我<00:02>爱 <00:03>you <00:04>😊<00:05>").lines[0];
        const next = editWordTimedLine(line, "我很爱 you 😊");
        expect(lineText(next)).toBe("我很爱 you 😊");
        expect(starts(next)).toEqual([1000, undefined, 2000, 3000, 4000]);
    });

    it("retains unchanged timed empty segments", () => {
        const line = {
            startMs: 1000,
            endMs: 4000,
            words: [
                { text: "hello", startMs: 1000, endMs: 1900 },
                { text: "", startMs: 2000, endMs: 2100 },
                { text: " world", startMs: 3000, endMs: 4000 },
            ],
        };
        const next = editWordTimedLine(line, "big hello world");
        expect(lineText(next)).toBe("big hello world");
        expect(next.words).toContainEqual(line.words[1]);
        expect(starts(next)).toEqual([undefined, 1000, 2000, 3000]);
    });

    it("preserves unchanged multi-character timed segments", () => {
        const line = parseEnhancedLrc("[00:01]<00:01>好き<00:02>です<00:03>").lines[0];
        const next = editWordTimedLine(line, "大好きです");
        expect(next.words.map((word) => word.text)).toEqual(["大", "好き", "です"]);
        expect(starts(next)).toEqual([undefined, 1000, 2000]);
    });

    it("updates sentence edges instead of stretching the new last word to a deleted ending", () => {
        const next = editWordTimedLine(original, "It's been a couple");
        expect(next.endMs).toBe(3640);
        const document = { ...parseEnhancedLrc(""), timingMode: "word" as const, lines: [next] };
        expect(toEnhancedLrc(document)).toContain("couple<00:03.640>");
        const extended = editWordTimedLine(original, "It's been a couple months later");
        expect(extended.endMs).toBeUndefined();
        expect(toEnhancedLrc({ ...document, lines: [extended] })).toMatch(/months <00:04\.510>later$/);
    });

    it("preserves both ends of unchanged words when exporting a deletion gap", () => {
        const next = editWordTimedLine(original, "It's been a months");
        const document = { ...parseEnhancedLrc(""), timingMode: "word" as const, lines: [next] };
        const restored = parseEnhancedLrc(toEnhancedLrc(document)).lines[0];
        expect(lineText(restored)).toBe("It's been a months");
        expect(restored.words.map(({ startMs, endMs }) => [startMs, endMs])).toEqual(
            original.words.filter((_, index) => index !== 3).map(({ startMs, endMs }) => [startMs, endMs]),
        );
    });

    it("retains a last word end separately from a later line end", () => {
        const line = { ...original, endMs: 5000 };
        const document = { ...parseEnhancedLrc(""), timingMode: "word" as const, lines: [line] };
        const restored = parseEnhancedLrc(toEnhancedLrc(document)).lines[0];
        expect(restored.words.at(-1)?.endMs).toBe(4510);
        expect(restored.endMs).toBe(5000);
    });

    it("does not introduce backwards markers for overlapping source words", () => {
        const document = {
            ...parseEnhancedLrc(""),
            timingMode: "word" as const,
            lines: [{
                startMs: 1000,
                endMs: 4000,
                words: [
                    { text: "a ", startMs: 1000, endMs: 3000 },
                    { text: "b", startMs: 2000, endMs: 4000 },
                ],
            }],
        };
        expect(toEnhancedLrc(document)).toBe("[00:01.000]<00:01.000>a <00:02.000>b<00:04.000>");
    });

    it("can clear all text and bound work on a very large replacement", () => {
        expect(editWordTimedLine(original, "").words).toEqual([{ text: "" }]);
        const next = editWordTimedLine(original, "new ".repeat(2000));
        expect(lineText(next)).toBe("new ".repeat(2000));
        expect(next.words.every((word) => word.startMs === undefined)).toBe(true);
    });
});
