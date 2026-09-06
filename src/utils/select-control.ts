export interface SelectOption {
    value: string | number;
    label: string;
    disabled?: boolean;
}

export const moveSelectIndex = (options: readonly SelectOption[], current: number, distance: number): number => {
    const enabled = options.flatMap((option, index) => option.disabled ? [] : [index]);
    if (!enabled.length) return -1;
    const position = enabled.indexOf(current);
    if (position < 0) return distance < 0 ? enabled[enabled.length - 1] : enabled[0];
    return enabled[Math.max(0, Math.min(enabled.length - 1, position + distance))];
};

export const matchSelectOption = (options: readonly SelectOption[], current: number, query: string): number => {
    const text = query.normalize("NFKC").toLocaleLowerCase();
    if (!text || !options.length) return current;
    const repeated = [...text].every((letter) => letter === [...text][0]);
    const prefix = repeated ? [...text][0] : text;
    const start = Math.max(0, current + (repeated ? 1 : 0));
    for (let offset = 0; offset < options.length; offset++) {
        const index = (start + offset) % options.length;
        const option = options[index];
        if (!option.disabled && option.label.normalize("NFKC").toLocaleLowerCase().startsWith(prefix)) return index;
    }
    return current;
};

interface SelectAnchor {
    left: number;
    top: number;
    bottom: number;
    width: number;
}

interface SelectViewport {
    left: number;
    top: number;
    width: number;
    height: number;
}

export const selectPopupPlacement = (
    anchor: SelectAnchor,
    viewport: SelectViewport,
    naturalWidth: number,
    naturalHeight: number,
): { left: number; top: number; width: number; maxHeight: number; side: "above" | "below" } => {
    const gutter = 10;
    const gap = 6;
    const width = Math.min(Math.max(anchor.width, naturalWidth), Math.max(1, viewport.width - gutter * 2));
    const topEdge = viewport.top + gutter;
    const bottomEdge = viewport.top + viewport.height - gutter;
    const below = Math.max(0, bottomEdge - anchor.bottom - gap);
    const above = Math.max(0, anchor.top - topEdge - gap);
    const desiredHeight = Math.min(naturalHeight, 352);
    const side = below >= desiredHeight || below >= above ? "below" : "above";
    const maxHeight = Math.max(1, Math.min(352, side === "below" ? below : above));
    return {
        left: Math.max(viewport.left + gutter, Math.min(anchor.left, viewport.left + viewport.width - gutter - width)),
        top: side === "below" ? anchor.bottom + gap : anchor.top - gap - Math.min(naturalHeight, maxHeight),
        width,
        maxHeight,
        side,
    };
};
