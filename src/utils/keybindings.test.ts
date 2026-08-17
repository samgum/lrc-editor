import { describe, expect, it } from "vitest";
import { defaultKeyBindings } from "./default-keybindings.js";
import { InputAction } from "./input-action.js";
import { cloneKeyBindings, findKeyBindingConflicts, normalizeKeyBindings } from "./keybindings.js";

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
});
