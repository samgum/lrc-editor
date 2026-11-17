import { describe, expect, it } from "vitest";
import { timingIssueAt } from "./timing-issues.js";

describe("timingIssueAt", () => {
    it("allows simultaneous word-mode line starts while still flagging a backwards start", () => {
        const lines = [{ time: 5 }, { time: 6 }, { time: 6 }, { time: 4 }, { time: 4 }, { time: 7 }];
        expect(lines.map((_, index) => timingIssueAt(lines, index, true))).toEqual([
            null,
            null,
            null,
            "timestampBackwards",
            null,
            null,
        ]);
        expect(lines.map((line) => line.time)).toEqual([5, 6, 6, 4, 4, 7]);
    });

    it("retains invalid-time warnings when simultaneous starts are allowed", () => {
        const lines = [{ time: Number.NaN }, { time: -1 }, {}, { time: 2 }];
        expect(lines.map((_, index) => timingIssueAt(lines, index, true))).toEqual([
            "invalidTimestamp",
            "invalidTimestamp",
            null,
            null,
        ]);
    });
    it("marks every row in a duplicate timestamp group", () => {
        const lines = [{ time: 1 }, { time: 2 }, { time: 2 }, { time: 2 }, { time: 3 }];
        expect(lines.map((_, index) => timingIssueAt(lines, index))).toEqual([
            null,
            "duplicateTimestamp",
            "duplicateTimestamp",
            "duplicateTimestamp",
            null,
        ]);
    });

    it("marks the row that moves backwards", () => {
        const lines = [{ time: 1 }, { time: 4 }, { time: 3 }, { time: 5 }];
        expect(lines.map((_, index) => timingIssueAt(lines, index))).toEqual([
            null,
            null,
            "timestampBackwards",
            null,
        ]);
    });

    it("ignores untimed rows and reports invalid numeric timestamps", () => {
        const lines = [{}, { time: Number.NaN }, { time: -1 }];
        expect(lines.map((_, index) => timingIssueAt(lines, index))).toEqual([
            null,
            "invalidTimestamp",
            "invalidTimestamp",
        ]);
    });

    it("detects duplicate and backwards timestamps across intervening untimed rows", () => {
        const lines = [{ time: 4 }, {}, { time: 4 }, {}, { time: 2 }];
        expect(lines.map((_, index) => timingIssueAt(lines, index))).toEqual([
            "duplicateTimestamp",
            null,
            "duplicateTimestamp",
            null,
            "timestampBackwards",
        ]);
    });
});
