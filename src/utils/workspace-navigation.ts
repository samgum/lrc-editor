let preferenceFocus: "huhu" | null = null;

export const requestPreferenceFocus = (target: "huhu"): void => {
    preferenceFocus = target;
};

export const consumePreferenceFocus = (): "huhu" | null => {
    const target = preferenceFocus;
    preferenceFocus = null;
    return target;
};
