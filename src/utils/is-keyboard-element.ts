export const isKeyboardElement = (element: EventTarget | null): boolean => {
    if (!(element instanceof HTMLElement)) {
        return false;
    }

    return element.isContentEditable || element.closest("input, textarea, select") !== null;
};
