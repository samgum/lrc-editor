import { describe, expect, it } from "vitest";
import { timingIssueAt } from "./timing-issues.js";

describe("timingIssueAt", () => {
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
});
