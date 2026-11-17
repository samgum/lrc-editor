export const isKeyboardElement = (element: EventTarget | null): boolean => {
    if (!(element instanceof HTMLElement)) {
        return false;
    }

    return element.isContentEditable
        || element.closest("input, textarea, select, [role=\"combobox\"], [role=\"listbox\"]") !== null;
};

export const shouldIgnoreGlobalShortcut = (event: KeyboardEvent): boolean => {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229) {
        return true;
    }
    if (typeof document !== "undefined" && document.querySelector("dialog[open]:modal") !== null) {
        return true;
    }
    if (isKeyboardElement(event.target)) {
        return true;
    }
    if (
        (event.key === " " || event.code === "Space" || event.key === "Enter" || event.code === "Enter")
        && event.target instanceof HTMLElement
        && event.target.closest("button:not(.space-button), summary, a[href], [role=\"button\"], [role=\"slider\"]")
            !== null
    ) {
        return true;
    }
    return false;
};
