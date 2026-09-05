import { describe, expect, it } from "vitest";
import {
    accessibleThemeForeground,
    contrastRatio,
    hexToRgb,
    mixColor,
    themeContrastColor,
    themeForegroundPalette,
    themeSurfaces,
} from "./theme-color.js";

describe("accessible theme colors", () => {
    it.each([
        "#ff691f",
        "#fab81e",
        "#7fdbb6",
        "#19cf86",
        "#91d2fa",
        "#1b95e0",
        "#abb8c2",
        "#e81c4f",
        "#f58ea8",
        "#c877fe",
        "#ffffff",
        "#000000",
    ])(
        "preserves contrast on actual neutral and selected surfaces for %s",
        (hex) => {
            const theme = hexToRgb(hex);
            const palette = themeForegroundPalette(theme);
            for (const surface of themeSurfaces(theme, false)) {
                expect(contrastRatio(palette.light, surface)).toBeGreaterThanOrEqual(4.5);
            }
            for (const surface of themeSurfaces(theme, true)) {
                expect(contrastRatio(palette.dark, surface)).toBeGreaterThanOrEqual(4.5);
            }
            expect(contrastRatio(palette.light, mixColor([0, 0, 0], [243, 244, 246], 18 / 255))).toBeGreaterThanOrEqual(
                4.5,
            );
        },
    );
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
