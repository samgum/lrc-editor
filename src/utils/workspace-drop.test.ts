import { describe, expect, it } from "vitest";
import { classifyWorkspaceFiles, isLyricDropFile, isMediaDropFile } from "./workspace-drop.js";

describe("workspace file drop", () => {
    it("distinguishes lyric axes, playable media, encrypted media, and unsupported files", () => {
        expect(isLyricDropFile(new File([""], "song.enhanced.LRC"))).toBe(true);
        expect(isLyricDropFile(new File([""], "song.ass"))).toBe(false);
        expect(isMediaDropFile(new File([""], "song.flac"))).toBe(true);
        expect(isMediaDropFile(new File([""], "song.qmcflac"))).toBe(true);

        const result = classifyWorkspaceFiles([
            new File([""], "lyrics.ttml"),
            new File([""], "track.m4a"),
            new File([""], "second.srt"),
            new File([""], "cover.png"),
            new File([""], "second.mp3"),
        ]);
        expect(result.lyric?.name).toBe("lyrics.ttml");
        expect(result.media?.name).toBe("track.m4a");
        expect(result.extraLyrics.map((file) => file.name)).toEqual(["second.srt"]);
        expect(result.extraMedia.map((file) => file.name)).toEqual(["second.mp3"]);
        expect(result.unsupported.map((file) => file.name)).toEqual(["cover.png"]);
    });
});
