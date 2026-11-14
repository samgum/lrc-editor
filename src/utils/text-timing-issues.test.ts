import { describe, expect, it } from "vitest";
import { textTimingRows } from "./text-timing-issues.js";

describe("raw editor timing diagnostics", () => {
    it("allows overlapping voices in word mode while retaining line-mode diagnostics", () => {
        const source = "[00:05]<00:05>Lead<00:12>\n[00:05]<00:05>Harmony<00:13>\n[00:03]<00:03>Earlier<00:08>";
        expect(textTimingRows(source, true).map((row) => row.issue)).toEqual([null, null, null]);
        expect(textTimingRows(source).map((row) => row.issue)).toEqual([
            "duplicateTimestamp",
            "duplicateTimestamp",
            "timestampBackwards",
        ]);
        expect(textTimingRows("[00:xx]<00:01>invalid<00:02>", true)[0].issue).toBe("invalidTimestamp");
    });
    it("maps duplicate and backwards timestamps to physical lines past metadata", () => {
        const text = "[ti:test]\n[00:01.000]one\n[00:05.000]two\n[00:05.000]\n[00:03.000][Chorus]";
        const rows = textTimingRows(text);
        expect(rows.map((row) => row.issue)).toEqual([
            null,
            null,
            "duplicateTimestamp",
            "duplicateTimestamp",
            "timestampBackwards",
        ]);
        rows.forEach((row) => expect(text.slice(row.start, row.end)).toBe(row.text));
        expect(rows[4].text).toBe("[00:03.000][Chorus]");
    });

    it("preserves empty lines, mixed scripts, quotes, and CRLF selection offsets", () => {
        const text = "\r\n[00:01.123]日本語 English 😀\r\n\r\n[00:02.123](\"I can't see\")\r\n";
        const rows = textTimingRows(text);
        expect(rows).toHaveLength(5);
        expect(rows.every((row) => row.issue === null)).toBe(true);
        rows.forEach((row) => expect(text.slice(row.start, row.end)).toBe(row.text));
    });

    it("flags malformed time tags without treating metadata or section labels as errors", () => {
        const rows = textTimingRows("[ar:Singer]\n[Chorus]\n[00:xx]text\n[-01:02]text\n[00:");
        expect(rows.map((row) => row.issue)).toEqual([
            null,
            null,
            "invalidTimestamp",
            "invalidTimestamp",
            "invalidTimestamp",
        ]);
    });

    it("does not invent a final line when no newline exists", () => {
        expect(textTimingRows("[00:01]word")).toHaveLength(1);
        expect(textTimingRows("")).toEqual([{ text: "", start: 0, end: 0, issue: null }]);
    });

    it("checks word tags without mistaking the line tag or a shared boundary for duplicate starts", () => {
        const rows = textTimingRows(
            [
                "[00:01]<00:01>hello <00:02><00:02>world<00:03>",
                "[00:04]<00:04>zero <00:04>duration<00:05>",
                "[00:06]<00:06>back <00:05>wards<00:07>",
                "[00:08]<00:08>invalid<00:99>",
                "[00:10]<00:10>incomplete<00:",
            ].join("\n"),
            true,
        );
        expect(rows.map((row) => row.issue)).toEqual([
            null,
            "duplicateTimestamp",
            "timestampBackwards",
            "invalidTimestamp",
            "invalidTimestamp",
        ]);
    });
});
