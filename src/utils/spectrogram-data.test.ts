import { afterEach, describe, expect, it } from "vitest";
import {
    cacheSpectrogramData,
    calculateSpectrogram,
    clearOtherSpectrogramData,
    readSpectrogramData,
    spectrogramLayout,
    spectrumFractionAt,
    spectrumFrequencyAt,
} from "./spectrogram-data.js";

afterEach(() => clearOtherSpectrogramData(""));

describe("independent spectrogram analysis", () => {
    it("locates a known frequency from real PCM samples", () => {
        const rate = 24_000;
        const frequency = 1_000;
        const samples = Float32Array.from(
            { length: rate },
            (_, index) => 0.5 * Math.sin(2 * Math.PI * frequency * index / rate),
        );
        const data = calculateSpectrogram([samples], rate);
        const column = Math.floor(0.5 * rate / data.hop);
        const values = data.values.slice(column * data.bins, (column + 1) * data.bins);
        const strongest = values.indexOf(Math.max(...values));
        expect(strongest * rate / data.fftSize).toBeCloseTo(1_008, -1);
        expect(samples[1]).toBeCloseTo(0.5 * Math.sin(2 * Math.PI * frequency / rate));
    });

    it("does not cancel opposite-phase stereo audio or ignore the right channel", () => {
        const left = Float32Array.from({ length: 2_048 }, (_, index) => 0.5 * Math.sin(2 * Math.PI * index / 24));
        const right = Float32Array.from(left, (sample) => -sample);
        const mono = calculateSpectrogram([left], 24_000);
        expect(calculateSpectrogram([left, right], 24_000).values).toEqual(mono.values);
        expect(Math.max(...calculateSpectrogram([new Float32Array(left.length), right], 24_000).values))
            .toBeGreaterThan(180);
    });

    it("handles silence and audio shorter than an FFT window", () => {
        const quiet = calculateSpectrogram([new Float32Array(200)], 24_000);
        expect(quiet.columns).toBe(1);
        expect(quiet.values.every((value) => value === 0)).toBe(true);
        expect(() => calculateSpectrogram([], 24_000)).toThrow("INVALID_SPECTRUM_AUDIO");
    });

    it("reuses analysis across display changes and evicts other media", () => {
        const data = calculateSpectrogram([new Float32Array(2_048)], 24_000);
        cacheSpectrogramData("track-a", data);
        expect(readSpectrogramData("track-a")).toBe(data);
        expect(readSpectrogramData("track-b")).toBeUndefined();
        clearOtherSpectrogramData("track-b");
        expect(readSpectrogramData("track-a")).toBeUndefined();
    });

    it("keeps the frequency scale invertible and bounded by the real sample rate", () => {
        expect(spectrumFrequencyAt(0, 12_000)).toBeCloseTo(12_000);
        expect(spectrumFrequencyAt(1, 12_000)).toBeCloseTo(40);
        for (const frequency of [100, 500, 1_000, 4_000, 8_000]) {
            expect(spectrumFrequencyAt(spectrumFractionAt(frequency, 12_000), 12_000)).toBeCloseTo(frequency);
        }
    });

    it("bounds frequency-cache size even for hour-long audio", () => {
        for (const samples of [24_000, 24_000 * 600, 24_000 * 3600, 24_000 * 86_400]) {
            const layout = spectrogramLayout(samples);
            expect(layout.columns * layout.bins).toBeLessThanOrEqual(16 * 1024 * 1024);
        }
    });
});
