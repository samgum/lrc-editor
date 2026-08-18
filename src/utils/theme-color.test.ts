import { describe, expect, it } from "vitest";
import { accessibleThemeForeground, contrastRatio, hexToRgb, themeContrastColor } from "./theme-color.js";

describe("accessible theme colors", () => {
    it.each(["#7fdbb6", "#91d2fa", "#fab81e", "#f58ea8"])(
        "creates a readable light-surface foreground for %s",
        (hex) => {
            const foreground = accessibleThemeForeground(hexToRgb(hex), [255, 255, 255]);
            expect(contrastRatio(foreground, [255, 255, 255])).toBeGreaterThanOrEqual(4.5);
        },
    );

    it("creates a readable dark-surface foreground", () => {
        const foreground = accessibleThemeForeground(hexToRgb("#1b95e0"), [25, 28, 35]);
        expect(contrastRatio(foreground, [25, 28, 35])).toBeGreaterThanOrEqual(4.5);
    });

    it("chooses readable text for filled theme controls", () => {
        expect(themeContrastColor(hexToRgb("#fab81e"))).toBe("var(--black)");
        expect(themeContrastColor(hexToRgb("#1b95e0"))).toBe("var(--black)");
    });
});
