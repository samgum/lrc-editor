import { describe, expect, it } from "vitest";
import { defaultKeyBindings } from "./default-keybindings.js";
import { InputAction } from "./input-action.js";
import { cloneKeyBindings, findKeyBindingConflicts, getMatchedAction, normalizeKeyBindings } from "./keybindings.js";

describe("key binding helpers", () => {
    it("fills missing actions from defaults while preserving deliberately empty actions", () => {
        const normalized = normalizeKeyBindings({ [InputAction.Sync]: [] });
        expect(normalized[InputAction.Sync]).toEqual([]);
        expect(normalized[InputAction.TogglePlay]).toEqual(defaultKeyBindings[InputAction.TogglePlay]);
    });

    it("detects shortcuts that would match two actions", () => {
        const bindings = cloneKeyBindings(defaultKeyBindings);
        bindings[InputAction.NextLine] = [{ code: "Space" }];
        expect(findKeyBindingConflicts(bindings)).toHaveLength(1);
    });

    it("distinguishes Shift/Alt modifiers in conflict checks and prefers exact modifier matches", () => {
        const bindings = cloneKeyBindings(defaultKeyBindings);
        bindings[InputAction.Sync] = [{ code: "KeyM" }];
        bindings[InputAction.DeleteTime] = [{ code: "KeyM", shiftKey: true }];
        expect(findKeyBindingConflicts(bindings)).toHaveLength(0);

        const shiftEvent = {
            code: "KeyM",
            key: "M",
            ctrlKey: false,
            metaKey: false,
            shiftKey: true,
            altKey: false,
        } as KeyboardEvent;
        expect(getMatchedAction(shiftEvent, bindings)).toBe(InputAction.DeleteTime);
    });
});
