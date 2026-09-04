import { afterEach, describe, expect, it, vi } from "vitest";
import {
    cacheTimingPcm,
    clearOtherTimingPcm,
    readTimingPcm,
    timingPanelHeights,
    timingSampleRate,
    waveformPixelsPerSecond,
} from "./waveform-data.js";

afterEach(() => clearOtherTimingPcm(""));

const audio = (samples: Float32Array, sampleRate: number, duration = samples.length / sampleRate): AudioBuffer => ({
    duration,
    sampleRate,
    numberOfChannels: 1,
    length: samples.length,
    getChannelData: () => samples,
} as unknown as AudioBuffer);

describe("timing visualization data", () => {
    it("never treats decimated waveform peaks as PCM for a spectrogram", () => {
        cacheTimingPcm("peaks", audio(new Float32Array(8_000), 40, 200));
        expect(readTimingPcm("peaks")).toBeUndefined();
    });

    it("reuses real samples without copying or mixing songs", () => {
        const samples = new Float32Array(timingSampleRate);
        cacheTimingPcm("first", audio(samples, timingSampleRate));
        expect(readTimingPcm("first")?.channels[0]).toBe(samples);
        cacheTimingPcm("second", audio(new Float32Array(timingSampleRate), timingSampleRate));
        expect(readTimingPcm("first")).toBeUndefined();
        expect(readTimingPcm("second")?.duration).toBe(1);
        clearOtherTimingPcm("third");
        expect(readTimingPcm("second")).toBeUndefined();
    });

    it("does not retain large decoded audio beyond the 64 MiB cache budget", () => {
        const getChannelData = vi.fn();
        cacheTimingPcm(
            "large",
            {
                sampleRate: timingSampleRate,
                duration: 400,
                length: 9_600_000,
                numberOfChannels: 2,
                getChannelData,
            } as unknown as AudioBuffer,
        );
        expect(readTimingPcm("large")).toBeUndefined();
        expect(getChannelData).not.toHaveBeenCalled();
    });

    it("uses the actual scale for short clips that fill the viewport", () => {
        expect(waveformPixelsPerSecond(84, 1000, 2)).toBe(500);
        expect(waveformPixelsPerSecond(84, 1000, 200)).toBe(84);
        expect(waveformPixelsPerSecond(0, 1000, 200)).toBe(5);
    });

    it("gives the entire display area to the selected view", () => {
        expect(timingPanelHeights(380, true)).toEqual({ wave: 1, spectrum: 364 });
        expect(timingPanelHeights(380, false)).toEqual({ wave: 364, spectrum: 0 });
    });
});
