import { stringify } from "@lrc-maker/lrc-parser";
import { describe, expect, it } from "vitest";
import { createUntimedTranscript, validateAlignedLyrics, validateHuhuAlignedLyrics } from "./ai-alignment-result.js";

describe("AI alignment lyrics", () => {
    it("removes metadata, line timestamps, and enhanced word timestamps", () => {
        const source = [
            "[ar: Artist]",
            "[00:01.234]<00:01.234>Hello <00:01.800>world",
            "[00:02.500]",
            "[00:03.000]下一行",
        ].join("\n");
        expect(createUntimedTranscript(source, {})).toBe("Hello world\n\n下一行");
    });

    it("accepts a strict unique axis while preserving blank lines", () => {
        const aligned = validateAlignedLyrics(
            "Hello world\n\n下一行",
            "[00:01.23]Hello world\n[00:02.50]\n[00:03.00]下一行\n",
            {},
        );
        expect(aligned.map((line) => line.time)).toEqual([1.23, 2.5, 3]);
        expect(aligned.map((line) => line.text)).toEqual(["Hello world", "", "下一行"]);
    });

    it.each([
        "[00:01.000]One\n[00:01.000]Two",
        "[00:02.000]One\n[00:01.000]Two",
    ])("rejects duplicate or decreasing timestamps", (aligned) => {
        expect(() => validateAlignedLyrics("One\nTwo", aligned, {})).toThrow("AI_ALIGNMENT_DUPLICATE_TIME");
    });

    it("rejects an axis that changes or reorders lyric text", () => {
        expect(() =>
            validateAlignedLyrics(
                "One\nTwo",
                "[00:01.000]Two\n[00:02.000]One",
                {},
            )
        ).toThrow("AI_ALIGNMENT_TEXT_MISMATCH");
    });
});

describe("Huhu alignment result validation", () => {
    const transcript = "Previous lyric\n\nNext lyric";
    const overlappingBlank = "[00:52.444]Previous lyric\n[00:54.185]\n[00:54.146]Next lyric";

    it.each([3, 2] as const)("repairs the real 39 ms blank-line overlap at precision %i", (precision) => {
        expect(() => validateAlignedLyrics(transcript, overlappingBlank, {})).toThrow("AI_ALIGNMENT_DUPLICATE_TIME");
        const aligned = validateHuhuAlignedLyrics(transcript, overlappingBlank, {}, precision);
        expect(aligned.map((line) => line.text)).toEqual(["Previous lyric", "", "Next lyric"]);
        expect(aligned.map((line) => line.time)).toEqual([52.444, precision === 3 ? 54.145 : 54.14, 54.146]);

        const exported = stringify({ lyric: aligned, info: new Map() }, {
            fixed: precision,
            spaceStart: 0,
            spaceEnd: 0,
        });
        expect(() => validateAlignedLyrics(transcript, exported, {})).not.toThrow();
    });

    it("keeps valid blank lines and every existing lyric timestamp unchanged", () => {
        const lrc = "[00:52.444]Previous lyric\n[00:53.185]\n[00:54.146]Next lyric\n";
        expect(validateHuhuAlignedLyrics(transcript, lrc, {}, 3)).toEqual(validateAlignedLyrics(transcript, lrc, {}));
    });

    it.each([0, 1, 2, 3] as const)(
        "reserves distinct timestamps for consecutive blanks at precision %i",
        (precision) => {
            const aligned = validateHuhuAlignedLyrics(
                "One\n\n\nTwo",
                "[00:01.000]One\n[00:06.000]\n[00:02.000]\n[00:05.000]Two",
                {},
                precision,
            );
            const unit = 1 / 10 ** precision;
            expect(aligned.map((line) => line.time)).toEqual([1, 5 - 2 * unit, 5 - unit, 5]);
            expect(aligned.map((line) => line.text)).toEqual(["One", "", "", "Two"]);
        },
    );

    it("handles leading, trailing, and untimed separator blanks without moving lyrics", () => {
        const aligned = validateHuhuAlignedLyrics(
            "One\n\nTwo",
            "[00:00.000]\n[00:01.000]One\n\n[00:03.000]Two\n[00:02.000]",
            {},
            3,
        );
        expect(aligned.map((line) => line.time)).toEqual([0, 1, 1.001, 3, 3.001]);
    });

    it.each([
        "[00:01.000]One\n[00:01.000]Two",
        "[00:02.000]One\n[00:01.000]\n[00:01.500]Two",
        "[00:01.000]One\nTwo",
    ])("still rejects invalid nonblank lyric timing", (lrc) => {
        expect(() => validateHuhuAlignedLyrics("One\nTwo", lrc, {}, 3)).toThrow();
    });

    it("does not delete blank lines when no distinct timestamp fits", () => {
        expect(() => validateHuhuAlignedLyrics("One\n\nTwo", "[00:01.000]One\n[00:02.000]\n[00:01.001]Two", {}, 3))
            .toThrow("AI_ALIGNMENT_DUPLICATE_TIME");
    });

    it("does not accept lyric timestamps that become duplicates at the chosen precision", () => {
        expect(() => validateHuhuAlignedLyrics("One\nTwo", "[00:01.001]One\n[00:01.004]Two", {}, 2)).toThrow(
            "AI_ALIGNMENT_DUPLICATE_TIME",
        );
    });

    it.each([
        "[00:01.000]Two\n[00:02.000]One",
        "[00:01.000]One",
        "[00:01.000]One\n[00:02.000]Two\n[00:03.000]Extra",
    ])("still rejects missing, reordered, or changed lyric text", (lrc) => {
        expect(() => validateHuhuAlignedLyrics("One\nTwo", lrc, {}, 3)).toThrow("AI_ALIGNMENT_TEXT_MISMATCH");
    });

    it("rejects empty results", () => {
        expect(() => validateHuhuAlignedLyrics("One", "\n", {}, 3)).toThrow("AI_ALIGNMENT_EMPTY");
    });
});
