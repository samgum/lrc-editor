export type Rgb = readonly [number, number, number];

export const hexToRgb = (hex: string): [number, number, number] => {
    const normalized = hex.replace(/^#/, "");
    const value = Number.parseInt(normalized, 16);
    return [(value >> 0x10) & 0xff, (value >> 0x08) & 0xff, value & 0xff];
};

export const relativeLuminance = (rgb: Rgb): number =>
    rgb
        .map((value) => value / 255)
        .map((value) => value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4))
        .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);

export const contrastRatio = (first: Rgb, second: Rgb): number => {
    const firstLuminance = relativeLuminance(first);
    const secondLuminance = relativeLuminance(second);
    const lighter = Math.max(firstLuminance, secondLuminance);
    const darker = Math.min(firstLuminance, secondLuminance);
    return (lighter + 0.05) / (darker + 0.05);
};

export const accessibleThemeForeground = (
    theme: Rgb,
    surface: Rgb,
    minimumContrast = 4.5,
): [number, number, number] => {
    if (contrastRatio(theme, surface) >= minimumContrast) return [...theme];
    const target: Rgb = relativeLuminance(surface) > 0.5 ? [0, 0, 0] : [255, 255, 255];
    for (let amount = 0.02; amount <= 1; amount += 0.02) {
        const candidate = theme.map((value, index) => Math.round(value + (target[index] - value) * amount)) as [
            number,
            number,
            number,
        ];
        if (contrastRatio(candidate, surface) >= minimumContrast) return candidate;
    }
    return [...target];
};

export const themeContrastColor = (theme: Rgb): "var(--black)" | "var(--white)" =>
    contrastRatio(theme, [17, 17, 17]) >= contrastRatio(theme, [238, 238, 238])
        ? "var(--black)"
        : "var(--white)";

export const mixColor = (foreground: Rgb, background: Rgb, opacity: number): [number, number, number] =>
    background.map((value, index) => value * (1 - opacity) + foreground[index] * opacity) as [number, number, number];

export const themeSurfaces = (theme: Rgb, dark: boolean): Rgb[] =>
    dark
        ? [[16, 18, 24], [25, 28, 35], mixColor(theme, [25, 28, 35], 0.3)]
        : [
            [255, 255, 255],
            [243, 244, 246],
            mixColor([0, 0, 0], [243, 244, 246], 18 / 255),
            mixColor(theme, [255, 255, 255], 0.3),
        ];

export const themeForegroundPalette = (theme: Rgb): { light: Rgb; dark: Rgb } => {
    const shade = (dark: boolean): Rgb => {
        const surfaces = themeSurfaces(theme, dark);
        const target: Rgb = dark ? [255, 255, 255] : [0, 0, 0];
        for (let step = 0; step <= 100; step++) {
            const candidate = mixColor(target, theme, step / 100).map(Math.round) as [number, number, number];
            if (surfaces.every((surface) => contrastRatio(candidate, surface) >= 4.5)) return candidate;
        }
        return target;
    };
    return { light: shade(false), dark: shade(true) };
};
