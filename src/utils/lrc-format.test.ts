import { describe, expect, it } from "vitest";
import { formatTimeTag, stringifyLrc } from "./lrc-format.js";

describe("formatTimeTag and stringifyLrc", () => {
    it("rolls minute boundaries cleanly instead of producing :60", () => {
        expect(formatTimeTag(59.996, 2, true)).toBe("[01:00.00]");
        expect(formatTimeTag(59.9996, 3, true)).toBe("[01:00.000]");
        expect(formatTimeTag(59.6, 0, false)).toBe("01:00");
        expect(formatTimeTag(Number.NaN, 2, true)).toBe("");
        expect(formatTimeTag(Number.POSITIVE_INFINITY, 2, false)).toBe("");
    });

    it("serializes metadata and rounded timestamps without :60 tags", () => {
        const output = stringifyLrc(
            {
                info: new Map([["ti", "Song"]]),
                lyric: [{ time: 59.999, text: "Bridge" }, { text: "" }],
            },
            { fixed: 2, spaceStart: 1, spaceEnd: 0 },
        );
        expect(output).toBe("[ti: Song]\r\n[01:00.00] Bridge\r\n");
    });
});
