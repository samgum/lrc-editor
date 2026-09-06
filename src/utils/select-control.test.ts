import { describe, expect, it } from "vitest";
import { matchSelectOption, moveSelectIndex, type SelectOption, selectPopupPlacement } from "./select-control.js";

const options: SelectOption[] = [
    { value: "auto", label: "Auto" },
    { value: "en", label: "English" },
    { value: "disabled", label: "Klingon", disabled: true },
    { value: "ko", label: "Korean" },
    { value: "ko-en", label: "Korean + English" },
    { value: "zh", label: "简体中文" },
];

describe("shared select navigation", () => {
    it("navigates enabled choices without wrapping or changing the saved value", () => {
        expect(moveSelectIndex(options, 1, 1)).toBe(3);
        expect(moveSelectIndex(options, 3, -1)).toBe(1);
        expect(moveSelectIndex(options, 5, 1)).toBe(5);
        expect(moveSelectIndex(options, 0, -1)).toBe(0);
        expect(options.map(({ value }) => value)).toEqual(["auto", "en", "disabled", "ko", "ko-en", "zh"]);
    });

    it("supports Home, End and page movement", () => {
        expect(moveSelectIndex(options, 3, -Infinity)).toBe(0);
        expect(moveSelectIndex(options, 3, Infinity)).toBe(5);
        expect(moveSelectIndex(options, 0, 10)).toBe(5);
        expect(moveSelectIndex(options, 5, -10)).toBe(0);
    });

    it("handles removed, disabled and empty selections", () => {
        expect(moveSelectIndex(options, -1, 0)).toBe(0);
        expect(moveSelectIndex(options, 2, 1)).toBe(0);
        expect(moveSelectIndex([], 0, 1)).toBe(-1);
        expect(moveSelectIndex(options.map((option) => ({ ...option, disabled: true })), 0, 1)).toBe(-1);
    });

    it("finds prefixes, cycles repeated letters and skips disabled options", () => {
        expect(matchSelectOption(options, 0, "k")).toBe(3);
        expect(matchSelectOption(options, 3, "kk")).toBe(4);
        expect(matchSelectOption(options, 4, "kkk")).toBe(3);
        expect(matchSelectOption(options, 3, "korean +")).toBe(4);
        expect(matchSelectOption(options, 3, "kor")).toBe(3);
        expect(matchSelectOption(options, 3, "unmatched")).toBe(3);
    });

    it("accepts multilingual and full-width text", () => {
        expect(matchSelectOption(options, 0, "简")).toBe(5);
        expect(matchSelectOption(options, 0, "Ｅｎ")).toBe(1);
        expect(matchSelectOption([], -1, "x")).toBe(-1);
        expect(matchSelectOption(options, 1, "")).toBe(1);
    });
});

describe("shared select positioning", () => {
    const viewport = { left: 0, top: 64, width: 390, height: 660 };

    it("opens below when it fits and flips above near the player", () => {
        const below = selectPopupPlacement({ left: 150, top: 120, bottom: 160, width: 180 }, viewport, 200, 332);
        expect(below).toEqual({ left: 150, top: 166, width: 200, maxHeight: 352, side: "below" });
        const above = selectPopupPlacement({ left: 150, top: 600, bottom: 640, width: 180 }, viewport, 200, 172);
        expect(above).toEqual({ left: 150, top: 422, width: 200, maxHeight: 352, side: "above" });
    });

    it("constrains long translations on a narrow viewport", () => {
        const result = selectPopupPlacement({ left: 270, top: 280, bottom: 320, width: 110 }, viewport, 900, 900);
        expect(result.width).toBe(370);
        expect(result.left).toBe(10);
        expect(result.maxHeight).toBeLessThanOrEqual(352);
        expect(result.top + result.maxHeight).toBeLessThanOrEqual(714);
    });

    it("respects the visual viewport when zoomed or a mobile keyboard is open", () => {
        const zoomed = { left: 60, top: 120, width: 240, height: 220 };
        const result = selectPopupPlacement({ left: 185, top: 215, bottom: 255, width: 140 }, zoomed, 230, 352);
        expect(result.left).toBe(70);
        expect(result.width).toBe(220);
        expect(result.side).toBe("above");
        expect(result.top).toBe(130);
        expect(result.maxHeight).toBe(79);
    });
});
