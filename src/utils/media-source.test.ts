import { describe, expect, it } from "vitest";
import { extractSharedMediaUrl, parseMediaInput } from "./media-source.js";

describe("parseMediaInput", () => {
    it("converts NetEase song links to the public media endpoint", () => {
        expect(parseMediaInput("https://music.163.com/#/song?id=123456789")).toEqual({
            kind: "direct",
            url: "https://music.163.com/song/media/outer/url?id=123456789.mp3",
            persist: true,
        });
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
    });
});
