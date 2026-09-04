import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
    addTempoTap,
    beatGridLines,
    defaultBeatGrid,
    normalizeBeatGrid,
    readBeatGrid,
    saveBeatGrid,
    snapToBeatGrid,
    tappedBpm,
} from "./beat-grid.js";

describe("optional beat grid", () => {
    it("covers the new controls in all nine interface languages", () => {
        const english =
            JSON.parse(readFileSync(new URL("../languages/en-US.json", import.meta.url), "utf8")).advancedLyrics;
        const chinese =
            JSON.parse(readFileSync(new URL("../languages/zh-CN.json", import.meta.url), "utf8")).advancedLyrics;
        const other = JSON.parse(readFileSync(new URL("../const/feature_translations.json", import.meta.url), "utf8"));
        const keys = Object.keys(english).filter((key) =>
            key.startsWith("beat")
            || ["waveformHeight", "waveformBrightness", "spectrumCaptureHint", "lineSpectrumCaptureHint"].includes(key)
        );
        const languages = [
            english,
            chinese,
            ...Object.values(other).map((language) =>
                (language as { advancedLyrics: Record<string, string> }).advancedLyrics
            ),
        ];
        expect(languages).toHaveLength(9);
        for (const language of languages) {
            for (const key of keys) expect(language[key]).toBeTypeOf("string");
        }
    });
    it("starts disabled and never snaps while the grid or snap control is off", () => {
        const grid = defaultBeatGrid();
        expect(grid.enabled).toBe(false);
        expect(grid.snap).toBe(false);
        expect(beatGridLines(grid, 0, 5, 100, 10)).toEqual([]);
        expect(snapToBeatGrid(0.49, { ...grid, snap: true }, 100, 10)).toEqual({ time: 0.49, snapped: false });
        expect(snapToBeatGrid(0.49, { ...grid, enabled: true }, 100, 10)).toEqual({ time: 0.49, snapped: false });
    });

    it("draws beats, bar accents, and subdivisions from a fixed origin", () => {
        const grid = { ...defaultBeatGrid(), enabled: true, offset: 0.25, subdivision: 2 as const };
        const lines = beatGridLines(grid, 0, 3, 100, 10);
        expect(lines.find((line) => line.time === 0.25)).toMatchObject({ x: 25, kind: "bar", bar: 1 });
        expect(lines.find((line) => line.time === 0.5)).toMatchObject({ x: 50, kind: "subdivision" });
        expect(lines.find((line) => line.time === 0.75)).toMatchObject({ x: 75, kind: "beat" });
        expect(lines.find((line) => line.time === 2.25)).toMatchObject({ x: 225, kind: "bar", bar: 2 });
    });

    it("keeps absolute beat times stable across zoom and scrolling", () => {
        const grid = { ...defaultBeatGrid(), enabled: true, offset: 0.25 };
        const before = beatGridLines(grid, 0, 5, 100, 10).find((line) => line.time === 2.25);
        const after = beatGridLines(grid, 1, 3, 200, 10).find((line) => line.time === 2.25);
        expect(before?.x).toBe(225);
        expect(after?.x).toBe(250);
    });

    it("snaps only nearby clicks and supports Alt/Option bypass", () => {
        const grid = { ...defaultBeatGrid(), enabled: true, snap: true };
        expect(snapToBeatGrid(0.49, grid, 100, 10)).toEqual({ time: 0.5, snapped: true });
        expect(snapToBeatGrid(0.25, grid, 100, 10)).toEqual({ time: 0.25, snapped: false });
        expect(snapToBeatGrid(0.49, grid, 100, 10, true)).toEqual({ time: 0.49, snapped: false });
        expect(snapToBeatGrid(0.46, grid, 400, 10)).toEqual({ time: 0.46, snapped: false });
    });

    it("snaps subdivisions without crossing audio boundaries", () => {
        const grid = { ...defaultBeatGrid(), enabled: true, snap: true, subdivision: 4 as const };
        expect(snapToBeatGrid(0.12, grid, 100, 10)).toEqual({ time: 0.125, snapped: true });
        expect(snapToBeatGrid(0.12, grid, 100, 0.121)).toEqual({ time: 0.12, snapped: false });
        expect(snapToBeatGrid(0.01, { ...grid, offset: -0.02 }, 100, 10)).toEqual({ time: 0.01, snapped: false });
    });

    it("limits dense grids and rejects invalid viewport geometry", () => {
        const grid = { ...defaultBeatGrid(), enabled: true, bpm: 400, subdivision: 8 as const };
        const lines = beatGridLines(grid, 0, 500, 4, 500);
        expect(lines.length).toBeLessThanOrEqual(512);
        expect(lines.every((line, index) => index === 0 || line.x - lines[index - 1].x >= 8)).toBe(true);
        expect(beatGridLines(grid, 0, Infinity, 100, 10)).toEqual([]);
    });

    it("preserves negative first-beat offsets and normalizes invalid settings", () => {
        expect(normalizeBeatGrid({ ...defaultBeatGrid(), offset: -0.25 }).offset).toBe(-0.25);
        expect(normalizeBeatGrid({ ...defaultBeatGrid(), bpm: NaN, beatsPerBar: 0 })).toMatchObject({
            bpm: 120,
            beatsPerBar: 1,
        });
    });

    it("retains grid settings across views without sharing them with another audio source", () => {
        saveBeatGrid("track-a", { ...defaultBeatGrid(), enabled: true, snap: true, bpm: 97.5, offset: 0.2 });
        expect(readBeatGrid("track-a")).toMatchObject({ bpm: 97.5, offset: 0.2, enabled: true, snap: true });
        expect(readBeatGrid("track-b")).toEqual(defaultBeatGrid());
        for (let index = 0; index < 4; index++) saveBeatGrid(`new-${index}`, defaultBeatGrid());
        expect(readBeatGrid("track-a")).toEqual(defaultBeatGrid());
    });

    it("estimates a tapped tempo and resets stale or backwards taps", () => {
        let taps: number[] = [];
        for (const time of [100, 600, 1100, 1600]) taps = addTempoTap(taps, time);
        expect(tappedBpm(taps)).toBe(120);
        expect(addTempoTap(taps, 1650)).toEqual(taps);
        expect(addTempoTap(taps, 10)).toEqual([10]);
        expect(addTempoTap(taps, 10_000)).toEqual([10_000]);
        expect(tappedBpm([100, 600])).toBeUndefined();
        expect(tappedBpm([0, 500, 1000, 2000, 2500])).toBe(120);
    });
});
