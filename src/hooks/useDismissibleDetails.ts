import { useEffect } from "react";

export const useDismissibleDetails = (ref: React.RefObject<HTMLDetailsElement>): void => {
    useEffect(() => {
        const closeOutside = (event: PointerEvent): void => {
            const details = ref.current;
            if (details?.open && !details.contains(event.target as Node)) details.open = false;
        };
        const closeOnEscape = (event: KeyboardEvent): void => {
            const details = ref.current;
            if (
                event.key !== "Escape" || event.defaultPrevented || !details?.open
                || details.querySelector("details[open]")
            ) return;
            event.preventDefault();
            event.stopPropagation();
            details.open = false;
            details.querySelector("summary")?.focus({ preventScroll: true });
        };
        document.addEventListener("pointerdown", closeOutside);
        document.addEventListener("keydown", closeOnEscape);
        return () => {
            document.removeEventListener("pointerdown", closeOutside);
            document.removeEventListener("keydown", closeOnEscape);
        };
    }, [ref]);
};
