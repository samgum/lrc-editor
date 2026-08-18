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
