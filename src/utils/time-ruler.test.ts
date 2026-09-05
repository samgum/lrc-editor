import { describe, expect, it } from "vitest";
import { timeRulerTicks } from "./time-ruler.js";

describe("timing ruler", () => {
    it("keeps absolute timestamps aligned with a scrolled audio viewport", () => {
        const ticks = timeRulerTicks(12.125, 22.125, 840, 84, 3);
        expect(ticks[0]).toEqual({ time: 12.125, x: 0, edge: "start" });
        expect(ticks.at(-1)).toEqual({ time: 22.125, x: 840, edge: "end" });
        for (const tick of ticks) expect(tick.x).toBeCloseTo((tick.time - 12.125) * 84, 5);
        for (let index = 1; index < ticks.length; index++) {
            expect(ticks[index].x - ticks[index - 1].x).toBeGreaterThanOrEqual(79.99);
        }
    });

    it("uses the effective short-audio scale and stays within its duration", () => {
        const ticks = timeRulerTicks(0, 5, 1000, 200, 3);
        expect(ticks.at(-1)?.x).toBe(1000);
        expect(ticks.some((tick) => tick.time % 1 !== 0)).toBe(true);
        expect(ticks.every((tick) => tick.time <= 5 && tick.x >= 0 && tick.x <= 1000)).toBe(true);
    });

    it("does not label multiple fractional ticks at zero-decimal precision", () => {
        const ticks = timeRulerTicks(0, 2, 840, 420, 0);
        expect(ticks.map((tick) => tick.time)).toEqual([0, 1, 2]);
    });

    it("bounds label density and rejects unloaded viewport geometry", () => {
        expect(timeRulerTicks(0, 0, 400, 84, 3)).toEqual([]);
        expect(timeRulerTicks(0, 20, 400, Number.NaN, 3)).toEqual([]);
        expect(timeRulerTicks(0, 1, 80, 80, 3)).toHaveLength(1);
        expect(timeRulerTicks(7200, 9000, 840, 840 / 1800, 3).length).toBeLessThanOrEqual(12);
    });
});
