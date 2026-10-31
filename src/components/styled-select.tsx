import { useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
    matchSelectOption,
    moveSelectIndex,
    type SelectOption,
    selectPopupPlacement,
} from "../utils/select-control.js";

interface StyledSelectProps {
    value: string | number;
    options: readonly SelectOption[];
    onValueChange: (value: string) => void;
    label: string;
    name?: string;
    className?: string;
    tone?: "default" | "dark";
    disabled?: boolean;
}

export const StyledSelect: React.FC<StyledSelectProps> = ({
    value,
    options,
    onValueChange,
    label,
    name,
    className = "",
    tone = "default",
    disabled = false,
}) => {
    const id = useId();
    const trigger = useRef<HTMLButtonElement>(null);
    const popup = useRef<HTMLDivElement>(null);
    const search = useRef({ text: "", time: 0 });
    const [open, setOpen] = useState(false);
    const [active, setActive] = useState(-1);
    const [placement, setPlacement] = useState<ReturnType<typeof selectPopupPlacement> | null>(null);
    const selected = options.findIndex((option) => String(option.value) === String(value));
    const unavailable = disabled || options.every((option) => option.disabled);
    const expanded = open && !unavailable;
    const activeIndex = options[active] && !options[active].disabled
        ? active
        : moveSelectIndex(options, selected, 0);
    const close = (): void => {
        setOpen(false);
        search.current = { text: "", time: 0 };
    };
    const show = (index = moveSelectIndex(options, selected, 0)): void => {
        if (unavailable) return;
        setActive(index);
        setPlacement(null);
        setOpen(true);
    };
    const commit = (index: number): void => {
        const option = options[index];
        close();
        if (option && !option.disabled && String(option.value) !== String(value)) onValueChange(String(option.value));
    };

    useLayoutEffect(() => {
        if (!expanded) return;
        const button = trigger.current!;
        const list = popup.current!;
        let frame = 0;
        const place = (): void => {
            const anchor = button.getBoundingClientRect();
            const viewport = window.visualViewport;
            const top = viewport?.offsetTop ?? 0;
            const left = viewport?.offsetLeft ?? 0;
            const width = viewport?.width ?? document.documentElement.clientWidth;
            const height = viewport?.height ?? window.innerHeight;
            if (anchor.bottom < top || anchor.top > top + height || !button.getClientRects().length) {
                setOpen(false);
                return;
            }
            // Measure unconstrained content once per layout update, then wrap long labels within the viewport.
            list.style.width = "max-content";
            list.style.maxWidth = `${Math.max(1, width - 20)}px`;
            const naturalWidth = Math.max(160, list.offsetWidth);
            const popupWidth = Math.min(Math.max(anchor.width, naturalWidth), width - 20);
            list.style.width = `${popupWidth}px`;
            const headerBottom = document.querySelector(".app-header")?.getBoundingClientRect().bottom ?? top;
            const footerTop = document.querySelector(".app-footer")?.getBoundingClientRect().top ?? top + height;
            const safeTop = headerBottom <= anchor.top ? Math.max(top, headerBottom) : top;
            const safeBottom = footerTop >= anchor.bottom ? Math.min(top + height, footerTop) : top + height;
            const next = selectPopupPlacement(
                anchor,
                { top: safeTop, left, width, height: safeBottom - safeTop },
                naturalWidth,
                list.scrollHeight + 2,
            );
            list.style.width = `${next.width}px`;
            setPlacement((previous) =>
                previous
                    && Object.keys(next).every((key) =>
                        previous[key as keyof typeof next] === next[key as keyof typeof next]
                    )
                    ? previous
                    : next
            );
        };
        const schedule = (event?: Event): void => {
            if (event?.target instanceof Node && list.contains(event.target)) return;
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(place);
        };
        const outside = (event: PointerEvent): void => {
            const target = event.target as Node;
            if (!button.contains(target) && !list.contains(target)) setOpen(false);
        };
        const ancestors: HTMLDetailsElement[] = [];
        for (let parent = button.parentElement; parent; parent = parent.parentElement) {
            if (parent instanceof HTMLDetailsElement) ancestors.push(parent);
        }
        const toggle = (): void => {
            if (ancestors.some((details) => !details.open)) setOpen(false);
        };
        place();
        const observer = new ResizeObserver(() => schedule());
        observer.observe(button);
        window.addEventListener("resize", schedule);
        window.addEventListener("scroll", schedule, true);
        window.visualViewport?.addEventListener("resize", schedule);
        window.visualViewport?.addEventListener("scroll", schedule);
        document.addEventListener("pointerdown", outside, true);
        ancestors.forEach((details) => details.addEventListener("toggle", toggle));
        return () => {
            cancelAnimationFrame(frame);
            observer.disconnect();
            window.removeEventListener("resize", schedule);
            window.removeEventListener("scroll", schedule, true);
            window.visualViewport?.removeEventListener("resize", schedule);
            window.visualViewport?.removeEventListener("scroll", schedule);
            document.removeEventListener("pointerdown", outside, true);
            ancestors.forEach((details) => details.removeEventListener("toggle", toggle));
        };
    }, [expanded, options]);

    useLayoutEffect(() => {
        const list = popup.current;
        const option = list?.children[activeIndex] as HTMLElement | undefined;
        if (!expanded || !list || !option || !placement) return;
        if (option.offsetTop < list.scrollTop) list.scrollTop = option.offsetTop - 4;
        else if (option.offsetTop + option.offsetHeight > list.scrollTop + list.clientHeight) {
            list.scrollTop = option.offsetTop + option.offsetHeight - list.clientHeight + 4;
        }
    }, [activeIndex, expanded, placement]);

    const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
        if (event.nativeEvent.isComposing || event.ctrlKey || event.metaKey) return;
        const key = event.key;
        if (key === "Tab") {
            if (expanded) commit(activeIndex);
            return;
        }
        if (key === "Escape") {
            if (expanded) {
                event.preventDefault();
                event.stopPropagation();
                close();
            }
            return;
        }
        if (event.altKey && key !== "ArrowDown" && key !== "ArrowUp") return;
        if (["Enter", " ", "ArrowDown", "ArrowUp", "Home", "End", "PageDown", "PageUp"].includes(key)) {
            event.preventDefault();
            event.stopPropagation();
            if (event.repeat && (key === "Enter" || key === " ")) return;
            if (key === "Enter" || key === " " || (expanded && event.altKey && key === "ArrowUp")) {
                if (expanded) commit(activeIndex);
                else show();
            } else {
                const distance = key === "Home" ? -Infinity : key === "End"
                    ? Infinity
                    : key === "PageDown"
                    ? 10
                    : key === "PageUp"
                    ? -10
                    : key === "ArrowDown"
                    ? 1
                    : -1;
                if (expanded) setActive(moveSelectIndex(options, activeIndex, distance));
                else show(key === "Home" || key === "End" ? moveSelectIndex(options, selected, distance) : undefined);
            }
        } else if (key.length === 1 && !event.altKey) {
            event.preventDefault();
            event.stopPropagation();
            const now = performance.now();
            const text = (now - search.current.time < 700 ? search.current.text : "") + key;
            search.current = { text, time: now };
            const index = matchSelectOption(options, expanded ? activeIndex : selected, text);
            if (expanded) setActive(index);
            else show(index);
        }
    };

    return (
        <span className={`styled-select ${className}`} data-tone={tone}>
            {name && <input type="hidden" name={name} value={value} disabled={unavailable} />}
            <button
                ref={trigger}
                type="button"
                className="styled-select-trigger"
                role="combobox"
                aria-label={label}
                aria-haspopup="listbox"
                aria-controls={expanded ? `${id}-list` : undefined}
                aria-expanded={expanded}
                aria-activedescendant={expanded && activeIndex >= 0 ? `${id}-${activeIndex}` : undefined}
                disabled={unavailable}
                onClick={() => {
                    trigger.current?.focus({ preventScroll: true });
                    if (expanded) close();
                    else show();
                }}
                onKeyDown={onKeyDown}
                onKeyUp={(event) => event.stopPropagation()}
                onBlur={(event) => {
                    if (event.relatedTarget instanceof Node && popup.current?.contains(event.relatedTarget)) {
                        return;
                    }
                    close();
                }}
            >
                <span className="styled-select-value">{options[selected]?.label ?? String(value)}</span>
                <svg className="styled-select-chevron" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                    <path
                        d="m5 7.5 5 5 5-5"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    />
                </svg>
            </button>
            {expanded && createPortal(
                <div
                    ref={popup}
                    id={`${id}-list`}
                    role="listbox"
                    tabIndex={-1}
                    aria-label={label}
                    className="styled-select-popup"
                    data-tone={tone}
                    data-side={placement?.side ?? "below"}
                    style={placement
                        ? {
                            left: placement.left,
                            top: placement.top,
                            width: placement.width,
                            maxHeight: placement.maxHeight,
                        }
                        : { visibility: "hidden" }}
                    onPointerDown={(event) => {
                        // Keep the trigger focused and parent settings panels open while choosing an option.
                        if (event.pointerType === "mouse") event.preventDefault();
                        event.stopPropagation();
                    }}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={(event) => event.stopPropagation()}
                    onBlur={(event) => {
                        if (
                            event.relatedTarget instanceof Node
                            && (
                                trigger.current?.contains(event.relatedTarget)
                                || popup.current?.contains(event.relatedTarget)
                            )
                        ) {
                            return;
                        }
                        close();
                    }}
                >
                    {options.map((option, index) => (
                        <div
                            key={option.value}
                            id={`${id}-${index}`}
                            role="option"
                            aria-selected={selected === index}
                            aria-disabled={option.disabled || undefined}
                            className={`styled-select-option${activeIndex === index ? " is-active" : ""}`}
                            onPointerMove={(event) => {
                                if (event.pointerType === "mouse" && !option.disabled) setActive(index);
                            }}
                            onClick={() => {
                                if (option.disabled) return;
                                commit(index);
                                trigger.current?.focus({ preventScroll: true });
                            }}
                        >
                            <span>{option.label}</span>
                            <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                                <path
                                    d="m4.5 10 3.5 3.5 7.5-7.5"
                                    stroke="currentColor"
                                    strokeWidth="1.8"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                />
                            </svg>
                        </div>
                    ))}
                </div>,
                trigger.current?.closest("dialog[open]") ?? document.body,
            )}
        </span>
    );
};
