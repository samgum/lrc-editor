import { afterEach, describe, expect, it, vi } from "vitest";
import { requestNeteaseAudio, requestQQMusicAudio, requestYouTubeAudio } from "./media-extension-bridge.js";

describe("YouTube extension bridge", () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it("reports a missing extension quickly instead of waiting for media resolution", async () => {
        vi.useFakeTimers();
        const events = new EventTarget();
        vi.stubGlobal("location", { origin: "https://lrc.sgmy.org" });
        vi.stubGlobal("window", {
            addEventListener: events.addEventListener.bind(events),
            removeEventListener: events.removeEventListener.bind(events),
            postMessage: vi.fn(),
            setTimeout,
            clearTimeout,
        });

        const pending = requestYouTubeAudio("M7lc1UVf-VE");
        const assertion = expect(pending).rejects.toMatchObject({ code: "missing" });
        await vi.advanceTimersByTimeAsync(1_500);
        await assertion;
    });

    it("rejects an installed extension that predates the current bridge protocol", async () => {
        const events = new EventTarget();
        const postMessage = vi.fn();
        const windowStub = {
            addEventListener: events.addEventListener.bind(events),
            removeEventListener: events.removeEventListener.bind(events),
            postMessage,
            setTimeout,
            clearTimeout,
        };
        vi.stubGlobal("location", { origin: "https://lrc.sgmy.org" });
        vi.stubGlobal("window", windowStub);

        const pending = requestYouTubeAudio("M7lc1UVf-VE");
        const request = postMessage.mock.calls[0][0] as { requestId: string };
        const event = new Event("message");
        Object.defineProperties(event, {
            source: { value: windowStub },
            origin: { value: "https://lrc.sgmy.org" },
            data: { value: { type: "LRC_EDITOR_MEDIA_ACK", requestId: request.requestId, version: "0.3.0" } },
        });
        events.dispatchEvent(event);

        await expect(pending).rejects.toMatchObject({ code: "outdated" });
    });

    it("returns a validated song id for a NetEase short link", async () => {
        const events = new EventTarget();
        const postMessage = vi.fn();
        const windowStub = {
            addEventListener: events.addEventListener.bind(events),
            removeEventListener: events.removeEventListener.bind(events),
            postMessage,
            setTimeout,
            clearTimeout,
        };
        vi.stubGlobal("location", { origin: "https://lrc.sgmy.org" });
        vi.stubGlobal("window", windowStub);

        const pending = requestNeteaseAudio({ url: "https://163cn.tv/bdlP6XHD" });
        const request = postMessage.mock.calls[0][0] as { requestId: string };
        const dispatch = (data: unknown): void => {
            const event = new Event("message");
            Object.defineProperties(event, {
                source: { value: windowStub },
                origin: { value: "https://lrc.sgmy.org" },
                data: { value: data },
            });
            events.dispatchEvent(event);
        };
        dispatch({ type: "LRC_EDITOR_MEDIA_ACK", requestId: request.requestId, version: "0.4.6" });
        dispatch({
            type: "LRC_EDITOR_MEDIA_RESULT",
            requestId: request.requestId,
            ok: true,
            provider: "netease",
            songId: "3421081743",
            audioUrl: "https://m701.music.126.net/path/song.mp3?token=test",
            mimeType: "audio/mpeg",
        });

        await expect(pending).resolves.toEqual({
            songId: "3421081743",
            url: "https://m701.music.126.net/path/song.mp3?token=test",
            mimeType: "audio/mpeg",
        });
    });

    it("returns a validated complete QQ Music stream", async () => {
        const events = new EventTarget();
        const postMessage = vi.fn();
        const windowStub = {
            addEventListener: events.addEventListener.bind(events),
            removeEventListener: events.removeEventListener.bind(events),
            postMessage,
            setTimeout,
            clearTimeout,
        };
        vi.stubGlobal("location", { origin: "https://lrc.sgmy.org" });
        vi.stubGlobal("window", windowStub);

        const pending = requestQQMusicAudio({
            url: "https://c6.y.qq.com/base/fcgi-bin/u?__=LNIUcFeE9ZJc",
        });
        const request = postMessage.mock.calls[0][0] as { requestId: string };
        const dispatch = (data: unknown): void => {
            const event = new Event("message");
            Object.defineProperties(event, {
                source: { value: windowStub },
                origin: { value: "https://lrc.sgmy.org" },
                data: { value: data },
            });
            events.dispatchEvent(event);
        };
        dispatch({ type: "LRC_EDITOR_MEDIA_ACK", requestId: request.requestId, version: "0.4.6" });
        dispatch({
            type: "LRC_EDITOR_MEDIA_RESULT",
            requestId: request.requestId,
            ok: true,
            provider: "qqmusic",
            songMid: "001qJBYN2lctpI",
            audioUrl: "https://aqqmusic.tc.qq.com/C400001qJBYN2lctpI.m4a?guid=1&vkey=test",
            mimeType: "audio/mp4",
            duration: 14,
        });

        await expect(pending).resolves.toEqual({
            duration: 14,
            songMid: "001qJBYN2lctpI",
            url: "https://aqqmusic.tc.qq.com/C400001qJBYN2lctpI.m4a?guid=1&vkey=test",
            mimeType: "audio/mp4",
        });
    });
});
