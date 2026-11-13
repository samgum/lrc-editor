import { describe, expect, it } from "vitest";
import { centeredFollowOffset, followEndSpace, lookAheadFollowOffset } from "./follow-scroll.js";

describe("timing follow geometry", () => {
    it("centers a line before it reaches the viewport edge", () => {
        expect(centeredFollowOffset({ lineTop: 300, lineHeight: 50, safeTop: 140, safeBottom: 700 })).toBe(-95);
    });

    it("recalculates the target against a shorter portrait viewport", () => {
        const desktop = centeredFollowOffset({ lineTop: 500, lineHeight: 50, safeTop: 140, safeBottom: 820 });
        const portrait = centeredFollowOffset({ lineTop: 500, lineHeight: 50, safeTop: 210, safeBottom: 590 });
        expect(desktop).toBe(45);
        expect(portrait).toBe(125);
    });

    it("provides enough trailing space to center the final lines", () => {
        expect(followEndSpace(150, 750)).toBe(300);
        expect(followEndSpace(300, 380)).toBe(80);
    });
});

describe("word queue look-ahead", () => {
    it("scrolls while the active row is still visible to reserve two following rows", () => {
        expect(
            lookAheadFollowOffset({
                lineTop: 420,
                lineHeight: 64,
                safeTop: 150,
                safeBottom: 550,
                lookAheadHeight: 128,
            }),
        ).toBe(62);
    });

    it("leaves the first rows in place when there is already room for the next two", () => {
        expect(
            lookAheadFollowOffset({
                lineTop: 150,
                lineHeight: 64,
                safeTop: 150,
                safeBottom: 550,
                lookAheadHeight: 128,
            }),
        ).toBe(0);
    });

    it("uses the real height of wrapped following lines", () => {
        expect(
            lookAheadFollowOffset({
                lineTop: 300,
                lineHeight: 64,
                safeTop: 150,
                safeBottom: 550,
                lookAheadHeight: 220,
            }),
        ).toBe(34);
    });

    it("prioritizes the active row when fewer than three rows fit", () => {
        expect(
            lookAheadFollowOffset({
                lineTop: 180,
                lineHeight: 80,
                safeTop: 150,
                safeBottom: 270,
                lookAheadHeight: 160,
            }),
        ).toBe(30);
        expect(
            lookAheadFollowOffset({
                lineTop: 150,
                lineHeight: 180,
                safeTop: 150,
                safeBottom: 270,
                lookAheadHeight: 160,
            }),
        ).toBe(0);
    });

    it("reveals rows selected above the current scroll position", () => {
        expect(
            lookAheadFollowOffset({ lineTop: 70, lineHeight: 64, safeTop: 150, safeBottom: 550, lookAheadHeight: 128 }),
        ).toBe(-80);
    });

    it("does not scroll again after reaching the requested position", () => {
        const viewport = { lineTop: 500, lineHeight: 64, safeTop: 150, safeBottom: 550, lookAheadHeight: 128 };
        const offset = lookAheadFollowOffset(viewport);
        expect(lookAheadFollowOffset({ ...viewport, lineTop: viewport.lineTop - offset })).toBe(0);
        expect(lookAheadFollowOffset({ ...viewport, lineTop: NaN })).toBe(0);
    });
});
