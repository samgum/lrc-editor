import { defaultKeyBindings } from "./default-keybindings.js";
import { InputAction } from "./input-action.js";
import { inputActions } from "./input-action.js";

// Keyboard key binding definition
export interface KeyBinding {
    code?: string; // KeyboardEvent.code
    key?: string; // KeyboardEvent.key
    ctrlKey?: boolean; // Requires Ctrl/Cmd
    shiftKey?: boolean; // Requires Shift
    altKey?: boolean; // Requires Alt
}

// Action to keyboard bindings mapping
export type KeyBindings = Record<InputAction, KeyBinding[]>;

export interface KeyBindingConflict {
    binding: string;
    first: InputAction;
    second: InputAction;
}

export function matchKeyBinding(ev: KeyboardEvent, bindings: KeyBinding[]): boolean {
    return bindings.some((binding) => {
        // Modifier key matching strategy:
        // - Ctrl/Cmd: strict bidirectional check to prevent conflicts with browser shortcuts (e.g., Ctrl+W)
        // - Shift/Alt: only require if binding specifies, allow extra modifiers otherwise
        //   (e.g., Shift+ArrowUp still triggers PrevLine, matching original behavior)
        const ctrlOrMeta = ev.ctrlKey || ev.metaKey;
        if (binding.ctrlKey && !ctrlOrMeta) return false;
        if (!binding.ctrlKey && ctrlOrMeta) return false;
        if (binding.shiftKey && !ev.shiftKey) return false;
        if (binding.altKey && !ev.altKey) return false;

        // Check key
        if (binding.code && ev.code === binding.code) return true;
        if (binding.key && ev.key === binding.key) return true;
        return false;
    });
}

export function getMatchedAction(ev: KeyboardEvent, keyBindings: KeyBindings): InputAction | null {
    for (const [action, bindings] of Object.entries(keyBindings)) {
        if (matchKeyBinding(ev, bindings)) {
            return action as InputAction;
        }
    }
    return null;
}

export const cloneKeyBindings = (bindings: KeyBindings): KeyBindings =>
    Object.fromEntries(
        inputActions.map((action) => [action, bindings[action].map((binding) => ({ ...binding }))]),
    ) as KeyBindings;

export const normalizeKeyBindings = (value: unknown): KeyBindings => {
    const stored = typeof value === "object" && value !== null ? value as Partial<KeyBindings> : {};

    return Object.fromEntries(
        inputActions.map((action) => {
            const candidate = stored[action];
            if (!Array.isArray(candidate)) {
                return [action, defaultKeyBindings[action].map((binding) => ({ ...binding }))];
            }

            return [
                action,
                candidate.filter(isKeyBinding).map((binding) => ({
                    code: binding.code,
                    key: binding.key,
                    ctrlKey: Boolean(binding.ctrlKey),
                    shiftKey: Boolean(binding.shiftKey),
                    altKey: Boolean(binding.altKey),
                })),
            ];
        }),
    ) as KeyBindings;
};

export const findKeyBindingConflicts = (bindings: KeyBindings): KeyBindingConflict[] => {
    const seen = new Map<string, InputAction>();
    const conflicts: KeyBindingConflict[] = [];

    for (const action of inputActions) {
        for (const binding of bindings[action]) {
            const identity = bindingConflictIdentity(binding);
            const first = seen.get(identity);
            if (first !== undefined && first !== action) {
                conflicts.push({ binding: formatKeyBinding(binding), first, second: action });
            } else {
                seen.set(identity, action);
            }
        }
    }

    return conflicts;
};

export const formatKeyBinding = (binding: KeyBinding): string => {
    const parts: string[] = [];
    if (binding.ctrlKey) parts.push("Ctrl/Cmd");
    if (binding.altKey) parts.push("Alt");
    if (binding.shiftKey) parts.push("Shift");

    const aliases: Record<string, string> = {
        ArrowDown: "↓",
        ArrowLeft: "←",
        ArrowRight: "→",
        ArrowUp: "↑",
        Space: "Space",
    };
    const primary = binding.code || binding.key || "?";
    parts.push(aliases[primary] || primary.replace(/^Key/, "").replace(/^Digit/, ""));
    return parts.join("+");
};

const bindingConflictIdentity = (binding: KeyBinding): string =>
    [binding.code || `key:${binding.key || ""}`, binding.ctrlKey ? "ctrl" : "plain"].join("|");

const isKeyBinding = (value: unknown): value is KeyBinding => {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const binding = value as KeyBinding;
    return typeof binding.code === "string" || typeof binding.key === "string";
};
