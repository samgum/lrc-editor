import { describe, expect, it } from "vitest";
import { extractNeteaseSongId, isNeteaseShortUrl } from "./media-extension-protocol.js";

describe("NetEase media extension protocol", () => {
    it("accepts only constrained 163cn.tv short links", () => {
        expect(isNeteaseShortUrl("https://163cn.tv/bdlP6XHD")).toBe(true);
        expect(isNeteaseShortUrl("http://163cn.tv/bdlP6XHD")).toBe(false);
        expect(isNeteaseShortUrl("https://evil.163cn.tv/bdlP6XHD")).toBe(false);
        expect(isNeteaseShortUrl("https://163cn.tv.evil.example/bdlP6XHD")).toBe(false);
        expect(isNeteaseShortUrl("https://163cn.tv/../../admin")).toBe(false);
    });

    it("extracts song ids only from NetEase Music hosts", () => {
        expect(extractNeteaseSongId("https://y.music.163.com/m/song?id=3421081743&app_version=9.5.70"))
            .toBe("3421081743");
        expect(extractNeteaseSongId("https://music.163.com/#/song?id=123456789")).toBe("123456789");
        expect(extractNeteaseSongId("https://example.com/song?id=3421081743")).toBeNull();
    });
});
