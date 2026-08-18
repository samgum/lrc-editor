import { describe, expect, it } from "vitest";
import { createAacTranscodeArguments, disposeAudioTranscoder } from "./audio-transcoder.js";

describe("browser audio transcoder", () => {
    it("prepares a compact AAC copy for playback and AI alignment", () => {
        expect(createAacTranscodeArguments("source.flac", "prepared.m4a")).toEqual([
            "-i",
            "source.flac",
            "-map",
            "0:a:0",
            "-vn",
            "-map_metadata",
            "-1",
            "-c:a",
            "aac",
            "-b:a",
            "256k",
            "-movflags",
            "+faststart",
            "prepared.m4a",
        ]);
    });

    it("deletes virtual files and terminates the WebAssembly worker after every conversion", async () => {
        const deleted: string[] = [];
        let terminated = false;
        await disposeAudioTranscoder({
            deleteFile: async (path) => {
                deleted.push(path);
                return true;
            },
            terminate: () => {
                terminated = true;
            },
        }, ["source.flac", "prepared.m4a"]);
        expect(deleted).toEqual(["source.flac", "prepared.m4a"]);
        expect(terminated).toBe(true);
    });
});
