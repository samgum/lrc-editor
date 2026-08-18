import { afterEach, describe, expect, it, vi } from "vitest";
import { clearAlignmentMediaSource, getAlignmentMediaSource, setAlignmentMediaSource } from "./alignment-media.js";

describe("alignment media registry", () => {
    afterEach(() => {
        clearAlignmentMediaSource();
        vi.unstubAllGlobals();
    });

    it("reuses the exact local media blob", async () => {
        const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/flac" });
        setAlignmentMediaSource({ blob, name: "demo.flac" });
        await expect(getAlignmentMediaSource()).resolves.toEqual({ blob, name: "demo.flac" });
    });

    it("materializes a remembered remote URL only once", async () => {
        const fetchMock = vi.fn(async () =>
            new Response(new Uint8Array([4, 5, 6]), {
                headers: { "Content-Type": "audio/mpeg" },
            })
        );
        vi.stubGlobal("fetch", fetchMock);
        setAlignmentMediaSource({ name: "remote.mp3", url: "https://example.com/audio.mp3" });

        const first = await getAlignmentMediaSource();
        const second = await getAlignmentMediaSource();
        expect([...new Uint8Array(await first.blob.arrayBuffer())]).toEqual([4, 5, 6]);
        expect(second.blob).toBe(first.blob);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
