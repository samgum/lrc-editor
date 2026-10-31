import { parser } from "@lrc-maker/lrc-parser";
import { describe, expect, it } from "vitest";
import {
    buildOverwritePlan,
    cleanGeniusTracklist,
    convertLyricsCase,
    isCreditLine,
    overwriteLyrics,
    removeEmptyLines,
    removeTags,
    repairTimeline,
    replaceText,
    splitTranslation,
    splitTranslationWithStats,
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

    it("removes a leading bracketed lyric title and known section tags", () => {
        const text = [
            "[YOASOBI「Biri-Biri」歌詞]",
            "",
            "[Verse 1]",
            "xxx",
            "[YOASOBI「Biri-Biri」歌詞]",
        ].join("\n");
        const result = removeTags(parser(text), options);
        expect(result).not.toMatch(/^\[YOASOBI/u);
        expect(result).not.toContain("[Verse 1]");
        expect(result).toContain("xxx");
        expect(result).toContain("[YOASOBI「Biri-Biri」歌詞]");
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
        const result = overwriteLyrics(source, "你好\n\n世界\n不会追加", options);
        expect(result).toContain("[00:01.000]你好");
        expect(result).toContain("[00:02.000]");
        expect(result).toContain("[00:03.000]世界");
        expect(result).not.toContain("不会追加");
        expect(parser(result).lyric.map((line) => line.time)).toEqual(source.lyric.map((line) => line.time));
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

    it("does not consume translations for timed Genius section labels", () => {
        const timed = parser([
            "[00:11.109][Chorus: Hatsune Miku]",
            "[00:11.367]愛は何回誰と",
            "[00:13.780]やがてまたないんだよ",
            "[00:16.694]再会、いつなんだ、何度",
            "[00:19.084]夢の夢の世界で会いたい",
            "[00:22.285]今ここにいたいんだ",
            "[00:24.675]ねえ、やがてまたないんだよ",
            "[00:27.587]会いに行くさ、何度",
            "[00:30.247]夢の夢の世界で生きたい",
            "[00:33.357][Refrain: Grimes]",
            "[00:33.890]I was in a sideband",
            "[00:36.281]Faster and faster and faster and faster and faster",
            "[00:39.487]I was in a sideband",
            "[00:41.607]Faster and faster and faster and faster and faster",
            "[00:45.340]I was in a sideband",
            "[00:47.208]Faster and faster and faster and faster and faster",
            "[00:50.677]I was in a sideband",
            "[00:52.801]Faster and faster and faster and faster and faster",
            "[00:55.716][Interlude: Grimes]",
            "[00:57.846]お、またまた勝ったんや",
            "[01:04.763]No",
            "[01:07.165][Chorus: Hatsune Miku]",
            "[01:09.561]愛は何回誰と",
            "[01:11.956]やがてまたないんだよ",
            "[01:14.606]再会、いつなんだ、何度",
            "[01:17.265]夢の夢の世界で会いたい",
            "[01:20.462]今ここにいたいんだ",
            "[01:23.106]ねえ、やがてまたないんだよ",
            "[01:26.033]会いに行くさ、何度",
            "[01:28.423]夢の夢の世界で生きたい",
            "[01:31.875][Bridge: Hatsune Miku]",
            "[01:32.137](つ) Pneumonia",
            "[01:32.934](つ) Pneumonia",
            "[01:34.271](つ) Pneumonia",
            "[01:35.595]好きと信じて",
            "[01:36.924](つ) Pneumonia",
            "[01:38.526](つ) Pneumonia",
            "[01:39.852](つ) Pneumonia",
            "[01:41.173]咲いたな",
            "[01:42.639][Refrain: Grimes]",
            "[01:43.433]I was in a sideband",
            "[01:45.288]Faster and faster and faster and faster and faster",
            "[01:48.737]I was in a sideband",
            "[01:50.864]Faster and faster and faster and faster and faster",
            "[01:54.588]I was in a sideband",
            "[01:56.440]Faster and faster and faster and faster and faster",
            "[01:59.899]I was in a sideband",
            "[02:02.021]Faster and faster and faster and faster and faster",
            "[02:05.218][Outro: Grimes]",
            "[02:05.475]Faster and faster and faster and faster and faster",
            "[02:08.127]Faster and faster and faster and faster and faster",
        ].join("\n"));
        const translationLines = [
            "",
            "爱过几次 又与谁在一起",
            "终究还是不会再有了呢",
            "再会、是何时、还有多少次",
            "好想在梦中梦的世界里 与你相见",
            "现在就想留在这里",
            "呐 终究还是不会再有了呢",
            "我会去见你 不论多少次",
            "好想在梦中梦的世界里 活下去",
            "",
            "我曾处于侧波带中",
            "越来越快 越来越快 越来越快",
            "我曾处于侧波带中",
            "越来越快 越来越快 越来越快",
            "我曾处于侧波带中",
            "越来越快 越来越快 越来越快",
            "我曾处于侧波带中",
            "越来越快 越来越快 越来越快",
            "",
            "噢 又赢了呢",
            "不",
            "",
            "爱过几次 又与谁在一起",
            "终究还是不会再有了呢",
            "再会、是何时、还有多少次",
            "好想在梦中梦的世界里 与你相见",
            "现在就想留在这里",
            "呐 终究还是不会再有了呢",
            "我会去见你 不论多少次",
            "好想在梦中梦的世界里 活下去",
            "",
            "(啊) 肺炎",
            "(啊) 肺炎",
            "(啊) 肺炎",
            "我相信 这就是喜欢",
            "(啊) 肺炎",
            "(啊) 肺炎",
            "(啊) 肺炎",
            "盛开了呐",
            "",
            "我曾处于侧波带中",
            "越来越快 越来越快 越来越快",
            "我曾处于侧波带中",
            "越来越快 越来越快 越来越快",
            "我曾处于侧波带中",
            "越来越快 越来越快 越来越快",
            "我曾处于侧波带中",
            "越来越快 越来越快 越来越快",
            "",
            "越来越快 越来越快 越来越快",
            "越来越快 越来越快 越来越快",
        ];
        const result = overwriteLyrics(timed, translationLines.join("\n"), options);
        const mapped = parser(result).lyric;

        expect(mapped.map((line) => Number(line.time?.toFixed(3)))).toEqual([
            11.109,
            11.367,
            13.78,
            16.694,
            19.084,
            22.285,
            24.675,
            27.587,
            30.247,
            33.357,
            33.89,
            36.281,
            39.487,
            41.607,
            45.34,
            47.208,
            50.677,
            52.801,
            55.716,
            57.846,
            64.763,
            67.165,
            69.561,
            71.956,
            74.606,
            77.265,
            80.462,
            83.106,
            86.033,
            88.423,
            91.875,
            92.137,
            92.934,
            94.271,
            95.595,
            96.924,
            98.526,
            99.852,
            101.173,
            102.639,
            103.433,
            105.288,
            108.737,
            110.864,
            114.588,
            116.44,
            119.899,
            122.021,
            125.218,
            125.475,
            128.127,
        ]);
        expect(mapped.map((line) => line.text)).toEqual(translationLines);
        expect(mapped.filter((line) => line.text === "").map((line) => Number(line.time?.toFixed(3)))).toEqual([
            11.109,
            33.357,
            55.716,
            67.165,
            91.875,
            102.639,
            125.218,
        ]);
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

    it("removes a bracketed lyric document title only at the beginning", () => {
        const title = "[YOASOBI「Biri-Biri」歌詞]";
        const result = stripGeniusSections(`${title}\n\n[Verse 1]\nxxx\n${title}`, {
            strictMode: true,
            dropEmpty: false,
            dropSuggestions: true,
        });
        expect(result.removed).toEqual([title, "[Verse 1]"]);
        expect(result.text).toContain("xxx");
        expect(result.text.trimEnd().endsWith(title)).toBe(true);
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

    it("supports smart overwrite across credits, timed breaks, section labels, and paragraph blank lines", () => {
        const song = parser([
            "[ti: 晴天]",
            "[00:00.200]作词 : 周杰伦",
            "[00:00.800]作曲 : 周杰伦",
            "[00:01.500][Intro]",
            "[00:05.000]故事的小黄花",
            "[00:09.000]",
            "[00:12.000]从出生那年就飘着",
        ].join("\n"));

        const plan = buildOverwritePlan(
            song,
            "\nLittle yellow flowers of the story\n\n\nDrifting since the year of birth\n",
            options,
            { alignMode: "smart", outputMode: "replace", preserveCredits: true, ignoreBlankLines: true },
        );

        expect(plan.targetCount).toBe(2);
        expect(plan.inputCount).toBe(2);
        expect(plan.extraLines).toEqual([]);
        expect(plan.text).toContain("[00:00.200]作词 : 周杰伦");
        expect(plan.text).toContain("[00:00.800]作曲 : 周杰伦");
        expect(plan.text).toContain("[00:05.000]Little yellow flowers of the story");
        expect(plan.text).toContain("[00:09.000]\r\n");
        expect(plan.text).toContain("[00:12.000]Drifting since the year of birth");
    });

    it("keeps original lyrics when smart overwrite input is empty and supports inline & dual-line bilingual modes", () => {
        const emptyResult = overwriteLyrics(source, "", options, {
            alignMode: "smart",
            outputMode: "replace",
            unmatchedFallback: "keep",
        });
        expect(emptyResult).toContain("[00:01.000]Hello / 你好");
        expect(emptyResult).toContain("[00:03.000]Hello / 你好");

        const simpleSource = parser("[00:01.000]Hello\n[00:02.000]\n[00:03.000]World");
        const inlineResult = overwriteLyrics(simpleSource, "[00:10.000]<00:10.200>你好\n世界", options, {
            alignMode: "smart",
            outputMode: "inline",
            inlineTemplate: "%orig 「%trans」",
        });
        expect(inlineResult).toContain("[00:01.000]Hello 「你好」");
        expect(inlineResult).toContain("[00:03.000]World 「世界」");

        const dualResult = overwriteLyrics(simpleSource, "你好\n世界", options, {
            alignMode: "smart",
            outputMode: "dual-line",
        });
        expect(dualResult.split("\r\n")).toEqual([
            "[00:01.000]Hello",
            "[00:01.000]你好",
            "[00:02.000]",
            "[00:03.000]World",
            "[00:03.000]世界",
        ]);
    });

    it("supports manual skipped line indices and detects song credit lines without false positives", () => {
        expect(isCreditLine("作词 : 方文山")).toBe(true);
        expect(isCreditLine("Lyrics by: Taylor Swift")).toBe(true);
        expect(isCreditLine("作曲家在弹琴")).toBe(false);

        const withInterlude = parser("[00:01.000]Line 1\n[00:02.000](Guitar Solo)\n[00:03.000]Line 2");
        const skipped = new Set<number>([1]);
        const result = overwriteLyrics(withInterlude, "第一句\n第二句", options, {
            alignMode: "smart",
            skippedLineIndices: skipped,
        });
        expect(result).toContain("[00:01.000]第一句");
        expect(result).toContain("[00:02.000](Guitar Solo)");
        expect(result).toContain("[00:03.000]第二句");
    });

    it("supports partial-range time transforms and single-target translation splits", () => {
        const shiftedFromTwoSec = transformTimes(source, 1, 1000, options, 2.5);
        expect(shiftedFromTwoSec).toContain("[00:01.000]Hello / 你好");
        expect(shiftedFromTwoSec).toContain("[00:04.000]Hello / 你好");

        const splitStats = splitTranslationWithStats(source, /(.+?)\s*\/\s*(.+)/, options, "translation");
        expect(splitStats.matchedCount).toBe(2);
        expect(splitStats.text).toContain("[00:01.000]你好");
        expect(splitStats.text).not.toContain("Hello");
    });

    it("repairs timelines by expanding multi-timestamps, sorting chronologically, and resolving duplicates", () => {
        const messy = [
            "[ti: Messy]",
            "[00:20.000][00:05.000]  Chorus  ",
            "[00:10.000]Verse",
            "[00:05.000]Chorus",
        ].join("\n");

        const deduped = repairTimeline(messy, options, {
            expandMultiTimestamps: true,
            sortChronologically: true,
            duplicateStrategy: "dedupe-exact",
            trimSpaces: true,
        });
        expect(deduped.expandedCount).toBe(1);
        expect(deduped.reorderedCount).toBeGreaterThan(0);
        expect(deduped.duplicateResolvedCount).toBe(1);
        expect(deduped.text.split("\r\n")).toEqual([
            "[ti: Messy]",
            "[00:05.000]Chorus",
            "[00:10.000]Verse",
            "[00:20.000]Chorus",
        ]);

        const dualBlocks = "[00:01.000]Hello\n[00:02.000]World\n\n[00:01.000]你好\n[00:02.000]世界";
        const merged = repairTimeline(dualBlocks, options, {
            sortChronologically: true,
            duplicateStrategy: "merge-inline",
        });
        expect(merged.text).toContain("[00:01.000]Hello / 你好");
        expect(merged.text).toContain("[00:02.000]World / 世界");

        const nudged = repairTimeline("[00:01.000]A\n[00:01.000]B", options, {
            duplicateStrategy: "nudge",
        });
        expect(nudged.text.split("\r\n")).toEqual(["[00:01.000]A", "[00:01.001]B"]);
    });
});
