import { describe, expect, it } from "vitest";
import { parseQQMusicPlaybackPage, QQMusicNotPlayableError } from "./qqmusic-link.js";

const playbackHtml = (song: Record<string, unknown>): string => {
    const json = JSON.stringify({ song });
    return `<script>window.__ssrFirstPageData__=${JSON.stringify(json)};</script>`;
};

describe("QQ Music link resolution", () => {
    it("returns the complete public playback URL for a non-VIP track", () => {
        const html = playbackHtml({
            mid: "002aW19V1mP2h9",
            interval: 254,
            pay: { pay_play: 0 },
            action: { play: true, try: true, vip: false },
            playUrl: "http://aqqmusic.tc.qq.com/C400000RroTl3zUar4.m4a?guid=1&vkey=test",
        });

        expect(parseQQMusicPlaybackPage(html, "002aW19V1mP2h9")).toEqual({
            duration: 254,
            mimeType: "audio/mp4",
            url: "https://aqqmusic.tc.qq.com/C400000RroTl3zUar4.m4a?guid=1&vkey=test",
        });
    });

    it("rejects the 60-second preview returned for the supplied VIP-gated track", () => {
        const html = playbackHtml({
            mid: "003OD7DT38MXcx",
            interval: 283,
            pay: { pay_play: 1 },
            action: { play: false, try: true, tryPlay: true, vip: true },
            playUrl: "http://aqqmusic.tc.qq.com/RS02062nvCWN199QuM.mp3?guid=1&vkey=test",
        });

        expect(() => parseQQMusicPlaybackPage(html, "003OD7DT38MXcx")).toThrow(QQMusicNotPlayableError);
    });
});
