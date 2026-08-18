import { afterEach, describe, expect, it, vi } from "vitest";
import { requestYouTubeAudio } from "./media-extension-bridge.js";

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
});
