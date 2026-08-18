import { describe, expect, it } from "vitest";
import { centeredFollowOffset, followEndSpace } from "./follow-scroll.js";

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
