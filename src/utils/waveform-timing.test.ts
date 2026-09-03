import { describe, expect, it } from "vitest";
import { captureWaveformTime, setWaveformTimingHandler, waveformTimingActive } from "./waveform-timing.js";

describe("waveform timing bridge", () => {
    it("routes one waveform point to the active timing handler and cleans up by identity", () => {
        const captured: number[] = [];
        const removeFirst = setWaveformTimingHandler((time) => captured.push(time));
        expect(waveformTimingActive()).toBe(true);
        expect(captureWaveformTime(1.234)).toBe(true);

        const removeSecond = setWaveformTimingHandler((time) => captured.push(time * 2));
        removeFirst();
        expect(waveformTimingActive()).toBe(true);
        expect(captureWaveformTime(2)).toBe(true);
        expect(captured).toEqual([1.234, 4]);

        removeSecond();
        expect(waveformTimingActive()).toBe(false);
        expect(captureWaveformTime(3)).toBe(false);
    });
});
