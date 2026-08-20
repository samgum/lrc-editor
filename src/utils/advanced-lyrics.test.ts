import { DOMParser as XmlDomParser } from "@xmldom/xmldom";
import { describe, expect, it } from "vitest";
import {
    createWordTimedDocument,
    decodeKrc,
    decodeTextBytes,
    displayLineText,
    exportLineLyrics,
    formatLrcTimestamp,
    hasWordTiming,
    parseEnhancedLrc,
    parseKrc,
    parseLyricBytes,
    parseSrt,
    parseTtml,
    reconcileAdvancedDocument,
    serializeLyrics,
    toEnhancedLrc,
    tokenizeLyricText,
    toKrc,
    toLineLrc,
    toLineTimedDocument,
    toSrt,
    toTtml,
    wordTimingIssueAt,
} from "./advanced-lyrics.js";

const parseXml = (source: string): Document =>
    new XmlDomParser().parseFromString(source, "application/xml") as unknown as Document;

describe("advanced lyric formats", () => {
    it("imports enhanced LRC without losing spaces or the final word end", () => {
        const document = parseEnhancedLrc([
            "[ar: Artist]",
            "[00:06.970]<00:06.970>Me <00:07.361>and<00:07.659>",
            "[00:09.000]Line only",
        ].join("\n"));

        expect(document.sourceFormat).toBe("enhanced-lrc");
        expect(document.timingMode).toBe("word");
        expect(document.metadata).toEqual({ ar: "Artist" });
        expect(document.lines[0]).toEqual({
            startMs: 6970,
            endMs: 7659,
            words: [
                { text: "Me ", startMs: 6970, endMs: 7361 },
                { text: "and", startMs: 7361, endMs: 7659 },
            ],
        });
        expect(displayLineText(document.lines[0])).toBe("Me and");
        expect(toLineLrc(document, 3)).toContain("[00:06.970]Me and");
        expect(toEnhancedLrc(document, 3)).toContain(
            "[00:06.970]<00:06.970>Me <00:07.361>and<00:07.659>",
        );
    });

    it("keeps ordinary LRC in line mode", () => {
        const document = parseEnhancedLrc("[ti: Song]\n[00:01.25]Hello\nUntimed\n");
        expect(document.sourceFormat).toBe("lrc");
        expect(document.timingMode).toBe("line");
        expect(document.lines).toEqual([
            { startMs: 1250, endMs: undefined, words: [{ text: "Hello" }] },
            { words: [{ text: "Untimed" }] },
        ]);
        expect(hasWordTiming(document)).toBe(false);
    });

    it("reads and writes encrypted binary KRC", () => {
        const source = "[ti:Demo]\r\n[1000,1500]<0,600,0>Hello <600,900,0>world";
        const document = parseKrc(source);
        const bytes = toKrc(document);

        expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("krc1");
        expect(decodeKrc(bytes)).toContain("<0,600,0>Hello ");
        const reparsed = parseKrc(bytes);
        expect(reparsed.metadata).toEqual({ ti: "Demo" });
        expect(reparsed.lines[0].words).toEqual([
            { text: "Hello ", startMs: 1000, endMs: 1600 },
            { text: "world", startMs: 1600, endMs: 2500 },
        ]);
        expect(exportLineLyrics(reparsed, "lrc", 3)).toContain("[00:01.000]Hello world");
        expect(exportLineLyrics(reparsed, "srt", 3)).toContain("00:00:01,000 --> 00:00:02,500");
    });

    it("detects pasted plaintext KRC without relying on its file extension", () => {
        const source = "[1000,1500]<0,600,0>Hello <600,900,0>world";
        const document = parseLyricBytes("pasted.txt", new TextEncoder().encode(source));
        expect(document.sourceFormat).toBe("krc");
        expect(document.timingMode).toBe("word");
    });

    it("parses Apple-style word TTML and keeps background vocals linear", () => {
        const source = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata">
  <head><metadata><ttm:title>Demo</ttm:title></metadata></head>
  <body><div>
    <p begin="1.000s" end="3.000s"><span begin="1.000s" end="1.500s">Hello</span> <span begin="1.500s" end="2.500s">world</span><span ttm:role="x-bg"><span begin="1.200s" end="2.800s">harmony</span></span></p>
    <p begin="4.000s" dur="2.000s">Line only</p>
  </div></body>
</tt>`;
        const document = parseTtml(source, parseXml);

        expect(document.metadata.ti).toBe("Demo");
        expect(document.timingMode).toBe("word");
        expect(document.lines[0].startMs).toBe(1000);
        expect(document.lines[0].endMs).toBe(3000);
        expect(document.lines[0].words).toEqual([
            { text: "Hello ", startMs: 1000, endMs: 1500 },
            { text: "world", startMs: 1500, endMs: 2500 },
            { text: " (harmony)" },
        ]);
        expect(document.lines[1]).toEqual({
            startMs: 4000,
            endMs: 6000,
            words: [{ text: "Line only" }],
        });
        expect(exportLineLyrics(document, "ttml", 3)).toContain("itunes:timing=\"Line\"");
        expect(exportLineLyrics(document, "ttml", 3)).not.toContain("<span");
    });

    it("imports line-timed TTML without pretending it has word timing", () => {
        const source =
            `<tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="PT1.250S" end="PT3S">One line</p></div></body></tt>`;
        const document = parseTtml(source, parseXml);
        expect(document.timingMode).toBe("line");
        expect(document.lines[0]).toEqual({ startMs: 1250, endMs: 3000, words: [{ text: "One line" }] });
    });

    it("preserves leading TTML text and whitespace across untimed wrapper spans", () => {
        const source =
            `<tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="1s" end="3s">♪ <span begin="1s" end="2s">Hello</span><span><span begin="2s" end="3s"> world</span></span></p></div></body></tt>`;
        const document = parseTtml(source, parseXml);
        expect(document.lines[0].words).toEqual([
            { text: "♪ " },
            { text: "Hello", startMs: 1000, endMs: 2000 },
            { text: " world", startMs: 2000, endMs: 3000 },
        ]);
        expect(displayLineText(document.lines[0])).toBe("♪ Hello world");
    });

    it("imports multiline SRT cues as one stable LRC line", () => {
        const document = parseSrt([
            "1",
            "00:00:01,250 --> 00:00:03,500 position:50%",
            "First row",
            "Second row",
            "",
            "2",
            "00:00:04,000 --> 00:00:05,000",
            "Next",
        ].join("\r\n"));

        expect(document.timingMode).toBe("line");
        expect(document.lines[0]).toEqual({
            startMs: 1250,
            endMs: 3500,
            words: [{ text: "First row\nSecond row" }],
        });
        expect(toLineLrc(document, 3)).toContain("[00:01.250]First row / Second row");
        expect(toSrt(document)).toContain("00:00:01,250 --> 00:00:03,500\r\nFirst row\r\nSecond row");
    });

    it("detects formats and BOM-based text encodings from bytes", () => {
        const utf16 = new Uint8Array([
            0xff,
            0xfe,
            0x5b,
            0x00,
            0x30,
            0x00,
            0x30,
            0x00,
            0x3a,
            0x00,
            0x30,
            0x00,
            0x31,
            0x00,
            0x5d,
            0x00,
            0x41,
            0x00,
        ]);
        expect(decodeTextBytes(utf16)).toBe("[00:01]A");
        expect(parseLyricBytes("lyrics.lrc", utf16).lines[0].startMs).toBe(1000);
    });

    it("exports enhanced LRC, KRC, TTML, and SRT from the same document", () => {
        const document = createWordTimedDocument(
            [{ time: 1, text: "Hello world" }],
            new Map([["ti", "Demo"]]),
        );
        const timed = {
            ...document,
            lines: [{
                startMs: 1000,
                endMs: 3000,
                words: [
                    { text: "Hello ", startMs: 1000, endMs: 1800 },
                    { text: "world", startMs: 1800, endMs: 3000 },
                ],
            }],
        };

        expect(serializeLyrics(timed, "enhanced-lrc", 3)).toContain("<00:01.000>Hello <00:01.800>world");
        expect(serializeLyrics(timed, "krc")).toBeInstanceOf(Uint8Array);
        expect(toTtml(timed)).toContain("itunes:timing=\"Word\"");
        expect(toSrt(timed)).toContain("00:00:01,000 --> 00:00:03,000");
    });

    it("converts word timing into line LRC, SRT, TTML, and plain text", () => {
        const document = parseEnhancedLrc([
            "[ti: Demo]",
            "[00:01.000]<00:01.000>Hello <00:01.800>world<00:03.000>",
            "[00:04.000]<00:04.000>Next<00:05.000>",
        ].join("\n"));
        const collapsed = toLineTimedDocument(document);

        expect(collapsed.timingMode).toBe("line");
        expect(collapsed.lines[0].words).toEqual([{ text: "Hello world" }]);
        expect(exportLineLyrics(document, "lrc", 3)).toContain("[00:01.000]Hello world");
        expect(exportLineLyrics(document, "lrc", 3)).not.toContain("<00:");
        expect(exportLineLyrics(document, "srt", 3)).toContain("00:00:01,000 --> 00:00:03,000");
        expect(exportLineLyrics(document, "ttml", 3)).toContain("itunes:timing=\"Line\"");
        expect(exportLineLyrics(document, "ttml", 3)).not.toContain("<span");
        expect(exportLineLyrics(document, "txt", 3)).toBe("Hello world\r\nNext");
    });

    it("does not invent a timed subtitle axis from untimed plain text", () => {
        const document = parseEnhancedLrc("First\nSecond");
        expect(exportLineLyrics(document, "lrc", 3)).toBe("First\r\nSecond");
        expect(() => exportLineLyrics(document, "srt", 3)).toThrow(/requires a timestamp/u);
        expect(() => exportLineLyrics(document, "ttml", 3)).toThrow(/requires a timestamp/u);
    });

    it("tokenizes CJK by grapheme and Latin text by word while retaining separators", () => {
        expect(tokenizeLyricText("Hello, 世界！").map((word) => word.text)).toEqual(["Hello, ", "世", "界！"]);
    });

    it("reports duplicate and backwards word timestamps instead of repairing them", () => {
        const document = parseEnhancedLrc(
            "[00:01.000]<00:01.000>A<00:01.000>B<00:00.900>C<00:02.000>",
        );
        expect(wordTimingIssueAt(document, 0, 1)).toBe("duplicate");
        expect(wordTimingIssueAt(document, 0, 2)).toBe("backwards");
    });

    it("moves existing word timing with a line timestamp edited in line mode", () => {
        const document = parseEnhancedLrc(
            "[00:06.970]<00:06.970>Me <00:07.361>and<00:07.659>",
        );
        const reconciled = reconcileAdvancedDocument(
            document,
            [{ time: 2, text: "Me and" }],
            new Map(),
        );
        expect(reconciled?.lines[0]).toEqual({
            startMs: 2000,
            endMs: 2689,
            words: [
                { text: "Me ", startMs: 2000, endMs: 2391 },
                { text: "and", startMs: 2391, endMs: 2689 },
            ],
        });
    });

    it("rounds LRC timestamps at the requested precision", () => {
        expect(formatLrcTimestamp(59_999, 2)).toBe("[01:00.00]");
        expect(formatLrcTimestamp(61_234, 3, "angle")).toBe("<01:01.234>");
    });
});
