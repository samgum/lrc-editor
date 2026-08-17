import { describe, expect, it } from "vitest";
import { detectLosslessCodec, isLocalMediaFile, needsCodecFallback } from "./local-media.js";

describe("local media codec handling", () => {
    it("accepts known lossless extensions even when Windows provides no MIME type", () => {
        expect(isLocalMediaFile(new File(["data"], "track.flac"))).toBe(true);
        expect(isLocalMediaFile(new File(["data"], "track.alac"))).toBe(true);
    });

    it("detects ALAC sample entries inside an M4A container", async () => {
        const file = new File([new Uint8Array([0, 0, 0, 0, 0x61, 0x6c, 0x61, 0x63])], "track.m4a", {
            type: "audio/mp4",
        });
        await expect(detectLosslessCodec(file)).resolves.toBe("alac");
    });

    it("requests a fallback only when the browser cannot decode the detected codec", async () => {
        const file = new File(["data"], "track.flac", { type: "audio/flac" });
        const unsupported = { canPlayType: () => "" } as unknown as HTMLAudioElement;
        const supported = { canPlayType: () => "probably" } as unknown as HTMLAudioElement;
        await expect(needsCodecFallback(file, unsupported)).resolves.toBe(true);
        await expect(needsCodecFallback(file, supported)).resolves.toBe(false);
    });
});
