import { describe, expect, it } from "vitest";
import { createUntimedTranscript, validateAlignedLyrics } from "./ai-alignment-result.js";

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
