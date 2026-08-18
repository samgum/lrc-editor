export type Rgb = readonly [number, number, number];

export const hexToRgb = (hex: string): [number, number, number] => {
    const normalized = hex.replace(/^#/, "");
    const value = Number.parseInt(normalized, 16);
    return [(value >> 0x10) & 0xff, (value >> 0x08) & 0xff, value & 0xff];
};

export const relativeLuminance = (rgb: Rgb): number =>
    rgb
        .map((value) => value / 255)
        .map((value) => value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4))
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
