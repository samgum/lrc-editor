import { describe, expect, it, vi } from "vitest";
import { resolveNeteaseShortLink } from "./netease-link.js";

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
});
