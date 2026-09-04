import { afterEach, describe, expect, it, vi } from "vitest";
import { alignmentMediaName } from "./alignment-media.js";
import { mediaFileNameFromUrl, readYouTubeMediaLabel, safeMediaNameStem } from "./media-name.js";

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe("alignment upload filenames", () => {
    it("uses YouTube's public title and author without cookies or a key", async () => {
        const fetchMock = vi.fn().mockResolvedValue(Response.json({ title: "CLICK", author_name: "JISOO - Topic" }));
        vi.stubGlobal("fetch", fetchMock);
        const label = await readYouTubeMediaLabel("jLCo8597v_g");
        expect(label).toBe("CLICK - JISOO");
        expect(alignmentMediaName("youtube", "audio/mp4", label)).toBe("CLICK - JISOO.m4a");
        const [url, options] = fetchMock.mock.calls[0];
        expect(new URL(url).origin).toBe("https://www.youtube.com");
        expect(new URL(url).searchParams.get("url")).toBe("https://www.youtube.com/watch?v=jLCo8597v_g");
        expect(options.credentials).toBe("omit");
        expect(options.referrerPolicy).toBe("no-referrer");
        expect(options.headers).toBeUndefined();
    });

    it.each([
        ["audio/mp4; codecs=mp4a.40.2", "m4a"],
        ["audio/webm; codecs=opus", "webm"],
        ["audio/ogg; codecs=opus", "ogg"],
        ["audio/opus", "opus"],
        ["audio/aac", "aac"],
        ["audio/mpeg", "mp3"],
        ["audio/flac", "flac"],
        ["audio/x-wav", "wav"],
        ["video/mp4", "mp4"],
    ])("keeps the actual media container for %s", (mime, extension) => {
        expect(alignmentMediaName("youtube", mime, "Song - Artist")).toBe(`Song - Artist.${extension}`);
    });

    it("preserves direct filenames without putting query credentials in their names", () => {
        expect(mediaFileNameFromUrl("https://example.com/music/My%20Song%20-%20Artist.m4a?token=private"))
            .toBe("My Song - Artist.m4a");
        expect(mediaFileNameFromUrl("https://example.com/%E6%AD%8C%E6%9B%B2%20-%20%E6%AD%8C%E6%89%8B.FLAC"))
            .toBe("歌曲 - 歌手.FLAC");
        expect(mediaFileNameFromUrl("https://example.com/videoplayback?filename=private.m4a")).toBeUndefined();
        expect(mediaFileNameFromUrl("https://example.com/%broken.mp3")).toBeUndefined();
    });

    it("keeps Unicode names while replacing filesystem-unsafe characters", () => {
        expect(alignmentMediaName("youtube", "audio/mp4", "歌名: \"こんにちは\" / Artist?"))
            .toBe("歌名_ _こんにちは_ _ Artist_.m4a");
        expect(safeMediaNameStem("CON")).toBe("_CON");
        const name = alignmentMediaName("youtube", "audio/mp4", "歌曲".repeat(100));
        expect(name).toMatch(/\.m4a$/);
        expect(new TextEncoder().encode(name).byteLength).toBeLessThanOrEqual(164);
        expect(name).not.toContain("�");
    });

    it.each([null, {}, { title: 42 }, { title: " " }])("ignores missing or invalid metadata: %j", async (metadata) => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(metadata)));
        await expect(readYouTubeMediaLabel("jLCo8597v_g")).resolves.toBeUndefined();
    });

    it("uses the original title when author metadata is unavailable", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ title: "Original title" })));
        await expect(readYouTubeMediaLabel("jLCo8597v_g")).resolves.toBe("Original title");
    });

    it("treats unavailable metadata as optional", async () => {
        vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
        await expect(readYouTubeMediaLabel("jLCo8597v_g")).resolves.toBeUndefined();
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Unavailable", { status: 404 })));
        await expect(readYouTubeMediaLabel("jLCo8597v_g")).resolves.toBeUndefined();
    });

    it("bounds the metadata lookup and cancels the request after four seconds", async () => {
        vi.useFakeTimers();
        vi.stubGlobal(
            "fetch",
            vi.fn((_url, options) =>
                new Promise((_resolve, reject) => {
                    options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
                })
            ),
        );
        const pending = readYouTubeMediaLabel("jLCo8597v_g");
        await vi.advanceTimersByTimeAsync(4_000);
        await expect(pending).resolves.toBeUndefined();
        expect(vi.getTimerCount()).toBe(0);
    });

    it("does not request metadata for an invalid video id", async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);
        await expect(readYouTubeMediaLabel("invalid")).resolves.toBeUndefined();
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
