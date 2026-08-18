import { afterEach, describe, expect, it, vi } from "vitest";
import {
    getAiAlignmentSessionSnapshot,
    resetAiAlignmentSessionForTest,
    startAiAlignmentSession,
    stopAiAlignmentSession,
    subscribeAiAlignmentSession,
    updateAiAlignmentSessionState,
} from "./ai-alignment-session.js";

describe("AI alignment session", () => {
    afterEach(() => resetAiAlignmentSessionForTest());

    it("keeps progress when a page subscriber unmounts and remounts", () => {
        const listener = vi.fn();
        const unsubscribe = subscribeAiAlignmentSession(listener);
        updateAiAlignmentSessionState(() => ({
            phase: "running",
            progress: 0.42,
            visible: true,
        }));
        unsubscribe();

        expect(listener).toHaveBeenCalledOnce();
        expect(getAiAlignmentSessionSnapshot().state).toMatchObject({
            phase: "running",
            progress: 0.42,
            visible: true,
        });
    });

    it("allows only one operation and aborts it through the shared stop control", async () => {
        const started = startAiAlignmentSession(async (signal) => {
            updateAiAlignmentSessionState(() => ({ phase: "running", progress: 0.3, visible: true }));
            await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        });

        expect(started).toBe(true);
        expect(startAiAlignmentSession(async () => undefined)).toBe(false);
        expect(stopAiAlignmentSession()).toBe(true);
        expect(getAiAlignmentSessionSnapshot().state?.phase).toBe("stopping");
        await vi.waitFor(() => expect(getAiAlignmentSessionSnapshot().active).toBe(false));
    });
});
