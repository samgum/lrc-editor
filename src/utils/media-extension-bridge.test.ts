import { afterEach, describe, expect, it, vi } from "vitest";
import {
    requestBilibiliAudio,
    requestNeteaseAudio,
    requestQQMusicAudio,
    requestYouTubeAudio,
} from "./media-extension-bridge.js";

describe("YouTube extension bridge", () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    const musicBridge = (startRequest = () => requestYouTubeAudio("s466YCiHfKw", 90_000, true)) => {
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
        const pending = startRequest();
        const request = postMessage.mock.calls[0][0] as { requestId: string; preferSong: boolean; videoId: string };
        const dispatch = (data: object, origin = "https://lrc.sgmy.org", source: object = windowStub) => {
            const event = new Event("message");
            Object.defineProperties(event, {
                source: { value: source },
                origin: { value: origin },
                data: { value: { requestId: request.requestId, ...data } },
            });
            events.dispatchEvent(event);
        };
        return { pending, request, dispatch };
    };

    const videoResult = {
        type: "LRC_EDITOR_MEDIA_RESULT",
        ok: true,
        provider: "youtube",
        audioUrl: "https://test.googlevideo.com/videoplayback",
        mimeType: "audio/mp4",
        audioData: "AQID",
    };
    const youtubeMusic = { videoId: "cOARkf5ZmtI", title: "FALLEN ANGEL", artist: "JENNIE" };

    it("reports an explicitly unsupported capability without retiring the extension", async () => {
        const { pending, request, dispatch } = musicBridge();
        const assertion = expect(pending).rejects.toMatchObject({ code: "music-unsupported" });
        expect(request).toMatchObject({ videoId: "s466YCiHfKw", preferSong: true });
        dispatch({ type: "LRC_EDITOR_MEDIA_ACK", version: "0.4.6", youtubeMusic: false });
        await assertion;
    });

    it.each(["0.3.0", "0.4.6", undefined, "unknown", 123])(
        "accepts verified Music results without an ACK capability marker (version %s)",
        async (version) => {
            const { pending, dispatch } = musicBridge();
            dispatch({ type: "LRC_EDITOR_MEDIA_ACK", version });
            dispatch({ ...videoResult, youtubeMusic });
            await expect(pending).resolves.toMatchObject({ youtubeMusic, data: "AQID" });
        },
    );

    it("waits for the legacy result and rejects unverified MV audio instead of blaming its version", async () => {
        const { pending, dispatch } = musicBridge();
        const assertion = expect(pending).rejects.toMatchObject({ code: "music-unverified" });
        dispatch({ type: "LRC_EDITOR_MEDIA_ACK", version: "0.4.6" });
        dispatch(videoResult);
        await assertion;
    });

    it("carries the verified song identity with the downloaded audio", async () => {
        const { pending, dispatch } = musicBridge();
        dispatch({ type: "LRC_EDITOR_MEDIA_ACK", version: "0.4.6", youtubeMusic: true });
        const youtubeMusic = { videoId: "cOARkf5ZmtI", title: "FALLEN ANGEL", artist: "JENNIE" };
        dispatch({
            type: "LRC_EDITOR_MEDIA_RESULT",
            ok: true,
            provider: "youtube",
            audioUrl: "https://test.googlevideo.com/videoplayback",
            mimeType: "audio/mp4",
            audioData: "AQID",
            youtubeMusic,
        });
        await expect(pending).resolves.toMatchObject({ youtubeMusic, data: "AQID" });
    });

    it.each([
        undefined,
        { videoId: "invalid", title: "song", artist: "artist" },
        { videoId: "cOARkf5ZmtI", title: " ", artist: "artist" },
        { videoId: "cOARkf5ZmtI", title: "song", artist: 123 },
    ])(
        "rejects unconfirmed Music response metadata: %s",
        async (youtubeMusic) => {
            const { pending, dispatch } = musicBridge();
            const assertion = expect(pending).rejects.toMatchObject({ code: "music-unverified" });
            dispatch({ type: "LRC_EDITOR_MEDIA_ACK", version: "0.4.6", youtubeMusic: true });
            dispatch({
                type: "LRC_EDITOR_MEDIA_RESULT",
                ok: true,
                provider: "youtube",
                audioUrl: "https://test.googlevideo.com/videoplayback",
                mimeType: "audio/mp4",
                youtubeMusic,
            });
            await assertion;
        },
    );

    it("reports an unconfirmed song match without accepting MV bytes", async () => {
        const { pending, dispatch } = musicBridge();
        const assertion = expect(pending).rejects.toMatchObject({ reason: "MUSIC_TRACK_UNAVAILABLE" });
        dispatch({ type: "LRC_EDITOR_MEDIA_ACK", version: "0.4.6", youtubeMusic: true });
        dispatch({ type: "LRC_EDITOR_MEDIA_RESULT", ok: false, error: "MUSIC_TRACK_UNAVAILABLE" });
        await assertion;
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

    it.each(["0.3.0", "0.4.6", undefined])(
        "keeps regular video audio working with legacy version %s and no Music capability",
        async (version) => {
            const { pending, request, dispatch } = musicBridge(() => requestYouTubeAudio("M7lc1UVf-VE"));
            expect(request).not.toHaveProperty("preferSong");
            dispatch({ type: "LRC_EDITOR_MEDIA_ACK", version, youtubeMusic: false });
            dispatch(videoResult);
            await expect(pending).resolves.toMatchObject({ data: "AQID" });
        },
    );

    it("keeps Bilibili audio working without a version field", async () => {
        const { pending, dispatch } = musicBridge(() => requestBilibiliAudio("https://www.bilibili.com/video/BV12345"));
        dispatch({ type: "LRC_EDITOR_MEDIA_ACK" });
        dispatch({ ...videoResult, provider: "bilibili", audioUrl: "https://test.bilivideo.com/audio.m4a" });
        await expect(pending).resolves.toMatchObject({ url: "https://test.bilivideo.com/audio.m4a" });
    });

    it.each([
        { audioUrl: "http://test.googlevideo.com/videoplayback" },
        { audioUrl: "https://googlevideo.com.example.org/videoplayback" },
        { provider: "bilibili" },
        { mimeType: "text/html" },
        { mimeType: null },
        { audioData: 123 },
    ])("still rejects invalid provider results from legacy extensions: %j", async (invalid) => {
        const { pending, dispatch } = musicBridge(() => requestYouTubeAudio("M7lc1UVf-VE"));
        const assertion = expect(pending).rejects.toMatchObject({ code: "failed" });
        dispatch({ type: "LRC_EDITOR_MEDIA_ACK", version: "0.3.0" });
        dispatch({ ...videoResult, ...invalid });
        await assertion;
    });

    it("ignores messages from another origin, window or request", async () => {
        vi.useFakeTimers();
        const { pending, dispatch } = musicBridge();
        const assertion = expect(pending).rejects.toMatchObject({ code: "missing" });
        dispatch({ ...videoResult, youtubeMusic }, "https://example.org");
        dispatch({ ...videoResult, youtubeMusic }, "https://lrc.sgmy.org", {});
        dispatch({ ...videoResult, youtubeMusic, requestId: "another-request" });
        await vi.advanceTimersByTimeAsync(1_500);
        await assertion;
        expect(vi.getTimerCount()).toBe(0);
    });

    it("does not let repeated ACKs extend the resolution deadline", async () => {
        vi.useFakeTimers();
        const { pending, dispatch } = musicBridge();
        const assertion = expect(pending).rejects.toMatchObject({
            code: "failed",
            message: "Media resolution timed out",
        });
        dispatch({ type: "LRC_EDITOR_MEDIA_ACK" });
        await vi.advanceTimersByTimeAsync(45_000);
        dispatch({ type: "LRC_EDITOR_MEDIA_ACK" });
        await vi.advanceTimersByTimeAsync(45_000);
        await assertion;
        expect(vi.getTimerCount()).toBe(0);
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
