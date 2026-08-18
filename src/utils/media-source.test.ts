import { describe, expect, it } from "vitest";
import { extractMediaUrl, extractSharedMediaUrl, materializeExtensionMedia, parseMediaInput } from "./media-source.js";

describe("parseMediaInput", () => {
    it("converts NetEase song links to the public media endpoint", () => {
        expect(parseMediaInput("https://music.163.com/#/song?id=123456789")).toEqual({
            kind: "netease",
            originalUrl: "https://music.163.com/#/song?id=123456789",
            songId: "123456789",
        });
    });

    it("extracts and recognizes a NetEase short link from a complete share message", () => {
        const shared = "分享Troye Sivan的单曲《She’s the Best》https://163cn.tv/bdlP6XHD (@网易云音乐)";
        expect(parseMediaInput(shared)).toEqual({
            kind: "netease-short",
            originalUrl: "https://163cn.tv/bdlP6XHD",
        });
    });

    it("extracts HTTP links and removes trailing share punctuation", () => {
        expect(extractMediaUrl("请听：https://music.163.com/song?id=3421081743。"))
            .toBe("https://music.163.com/song?id=3421081743");
        expect(() => extractMediaUrl("这里没有链接"))
            .toThrow("does not contain");
    });

    it.each([
        ["https://www.youtube.com/watch?v=M7lc1UVf-VE", "M7lc1UVf-VE"],
        ["https://music.youtube.com/watch?v=M7lc1UVf-VE&list=RDAMVM", "M7lc1UVf-VE"],
        [
            "https://www.youtube.com/watch?v=60rlboK94mE&list=OLAK5uy_n-ILXqnNS71YHbWdlXOaQ_jx9d1l_8C2I&index=3",
            "60rlboK94mE",
        ],
        ["https://music.youtube.com/watch?v=78wrful9cVU&si=KniWVWPKTKFA-jzz", "78wrful9cVU"],
        ["https://youtu.be/M7lc1UVf-VE?t=12", "M7lc1UVf-VE"],
        ["https://www.youtube.com/shorts/M7lc1UVf-VE", "M7lc1UVf-VE"],
    ])("recognizes YouTube video links: %s", (url, videoId) => {
        expect(parseMediaInput(url)).toMatchObject({ kind: "youtube", videoId });
    });

    it("does not persist signed Googlevideo URLs", () => {
        expect(parseMediaInput("https://r1---sn.example.googlevideo.com/videoplayback?expire=1&sig=secret"))
            .toMatchObject({ kind: "direct", persist: false });
    });

    it.each([
        "https://www.bilibili.com/video/BV1xx411c7mD/",
        "https://www.bilibili.com/video/av170001",
        "https://b23.tv/BV1xx411c7mD",
    ])("recognizes Bilibili video links: %s", (url) => {
        expect(parseMediaInput(url)).toMatchObject({ kind: "bilibili" });
    });

    it("rejects non-video Bilibili links", () => {
        expect(() => parseMediaInput("https://www.bilibili.com/")).toThrow();
    });

    it("rejects non-video YouTube links", () => {
        expect(() => parseMediaInput("https://www.youtube.com/playlist?list=abc")).toThrow();
    });
});

describe("extractSharedMediaUrl", () => {
    it("reads explicit and shared-text URLs", () => {
        expect(extractSharedMediaUrl(new URL("https://lrc.sgmy.org/?url=https%3A%2F%2Fexample.com%2Fa.mp3")))
            .toBe("https://example.com/a.mp3");
        expect(
            extractSharedMediaUrl(new URL("https://lrc.sgmy.org/?text=Listen%20https%3A%2F%2Fyoutu.be%2FM7lc1UVf-VE")),
        )
            .toBe("https://youtu.be/M7lc1UVf-VE");
        expect(
            extractSharedMediaUrl(
                new URL(
                    "https://lrc.sgmy.org/?title=%E5%88%86%E4%BA%AB%E6%AD%8C%E6%9B%B2%20https%3A%2F%2F163cn.tv%2FbdlP6XHD%20(%40%E7%BD%91%E6%98%93%E4%BA%91%E9%9F%B3%E4%B9%90)",
                ),
            ),
        ).toBe("https://163cn.tv/bdlP6XHD");
    });
});

describe("materializeExtensionMedia", () => {
    it("turns extension-provided audio data into an in-memory blob", async () => {
        const src = await materializeExtensionMedia({
            src: "https://example.googlevideo.com/videoplayback",
            data: btoa(String.fromCharCode(0, 1, 2, 3)),
            mimeType: "audio/mp4",
            persist: false,
            provider: "youtube-extension",
        });
        try {
            const blob = await fetch(src).then((response) => response.blob());
            expect(blob.type).toBe("audio/mp4");
            expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([0, 1, 2, 3]);
        } finally {
            URL.revokeObjectURL(src);
        }
    });
});
