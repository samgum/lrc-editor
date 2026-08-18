import { parser } from "@lrc-maker/lrc-parser";
import { describe, expect, it } from "vitest";
import {
    cleanGeniusTracklist,
    convertLyricsCase,
    overwriteLyrics,
    removeEmptyLines,
    removeTags,
    replaceText,
    splitTranslation,
    stripGeniusSections,
    transformTimes,
} from "./lrc-tools.js";

const options = { fixed: 3 as const, spaceStart: 0, spaceEnd: 0 };
const source = parser("[ti: Demo]\n[00:01.000]Hello / 你好\n[00:02.000]\n[00:03.000]Hello / 你好");

describe("LRC tools", () => {
    it("removes tags and empty lines", () => {
        expect(removeTags(source, options)).toBe("Hello / 你好\r\n\r\nHello / 你好");
        expect(removeEmptyLines(source, options)).not.toContain("[00:02.000]");
    });

    it("applies a linear time transform", () => {
        const result = transformTimes(source, 2, 500, options);
        expect(result).toContain("[00:02.500]Hello / 你好");
        expect(transformTimes(source, 1, -500, options)).toContain("[00:00.500]Hello / 你好");
    });

    it("splits translation text into two LRC blocks", () => {
        const result = splitTranslation(source, /(.+?)\s*\/\s*(.+)/, options);
        expect(result).toContain("[00:01.000]Hello");
        expect(result).toContain("[00:01.000]你好");
    });

    it("builds a translation axis without shifting across timed blank lines", () => {
        const result = overwriteLyrics(source, "你好\n世界", options);
        expect(result).toContain("[00:01.000]你好");
        expect(result).toContain("[00:02.000]");
        expect(result).toContain("[00:03.000]世界");
    });

    it("accepts translated LRC input while retaining the source axis", () => {
        const result = overwriteLyrics(
            source,
            "[by: Translator]\n[00:09.000]你好\n[00:10.000]\n[00:11.000]世界",
            options,
        );
        expect(result).toContain("[00:01.000]你好");
        expect(result).toContain("[00:02.000]");
        expect(result).toContain("[00:03.000]世界");
        expect(result).not.toContain("00:09.000");
    });

    it("removes Genius section labels without damaging LRC tags", () => {
        const result = stripGeniusSections("[Intro: LISA]\n[00:01.000]Hello\n[ti: Chorus Song]", {
            strictMode: true,
            dropEmpty: false,
            dropSuggestions: true,
        });
        expect(result.removed).toEqual(["[Intro: LISA]"]);
        expect(result.text).toContain("[00:01.000]Hello");
        expect(result.text).toContain("[ti: Chorus Song]");
    });

    it("cleans Genius tracklists and featured artists", () => {
        const result = cleanGeniusTracklist("Album songs\n1\nSong One Lyrics\n1.4K\n2\nSong Two (Ft. Guest) Lyrics", {
            keepTitle: true,
            stripFeatured: true,
        });
        expect(result.text).toBe("ALBUM\n1. Song One\n2. Song Two");
    });

    it("replaces multiple plain targets", () => {
        expect(replaceText("one two one", {
            find: "one|two",
            replacement: "x",
            regex: false,
            caseSensitive: false,
        })).toMatchObject({ text: "x x x", count: 3 });
    });

    it("changes lyric case while preserving timestamps", () => {
        expect(convertLyricsCase("[00:01.000]i'M READY.\n[00:02.000]i know", "sentence", true, true))
            .toBe("[00:01.000]I'm ready.\n[00:02.000]I know");
    });
});
