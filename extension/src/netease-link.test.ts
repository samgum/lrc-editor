import { describe, expect, it, vi } from "vitest";
import { resolveNeteaseAudioUrl, resolveNeteaseShortLink } from "./netease-link.js";

describe("NetEase short-link expansion", () => {
    it("returns the song id from the followed NetEase redirect", async () => {
        const fetchMock = vi.fn(async () => {
            const response = new Response(null, { status: 200 });
            Object.defineProperty(response, "url", {
                value: "https://y.music.163.com/m/song?id=3421081743&app_version=9.5.70",
            });
            return response;
        });

        await expect(resolveNeteaseShortLink("https://163cn.tv/bdlP6XHD", fetchMock as typeof fetch))
            .resolves.toBe("3421081743");
        expect(fetchMock).toHaveBeenCalledWith(
            "https://163cn.tv/bdlP6XHD",
            expect.objectContaining({ method: "HEAD", redirect: "follow", credentials: "omit" }),
        );
    });

    it("rejects redirects outside NetEase Music", async () => {
        const fetchMock = vi.fn(async () => {
            const response = new Response(null, { status: 200 });
            Object.defineProperty(response, "url", { value: "https://example.com/song?id=3421081743" });
            return response;
        });

        await expect(resolveNeteaseShortLink("https://163cn.tv/bdlP6XHD", fetchMock as typeof fetch)).rejects
            .toThrow("did not resolve");
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("upgrades the validated NetEase CDN audio redirect to HTTPS", async () => {
        const fetchMock = vi.fn(async () => {
            const response = new Response(null, {
                status: 200,
                headers: { "Content-Type": "audio/mpeg; charset=UTF-8" },
            });
            Object.defineProperty(response, "url", {
                value: "http://m701.music.126.net/path/song.mp3?token=test",
            });
            return response;
        });

        await expect(resolveNeteaseAudioUrl("3421081743", fetchMock as typeof fetch)).resolves.toEqual({
            url: "https://m701.music.126.net/path/song.mp3?token=test",
            mimeType: "audio/mpeg",
        });
    });
});
