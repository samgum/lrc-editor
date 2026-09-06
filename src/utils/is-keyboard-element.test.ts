import { afterEach, describe, expect, it, vi } from "vitest";
import { isKeyboardElement } from "./is-keyboard-element.js";

afterEach(() => vi.unstubAllGlobals());

describe("timing shortcut input guard", () => {
    it("recognizes both custom menu roles without disabling all ordinary buttons", () => {
        class TestElement {
            isContentEditable = false;
            constructor(readonly selector: string) {}
            closest(selectors: string): TestElement | null {
                return selectors.split(", ").includes(this.selector) ? this : null;
            }
        }
        vi.stubGlobal("HTMLElement", TestElement);
        for (const selector of ["input", "textarea", "select", "[role=\"combobox\"]", "[role=\"listbox\"]"]) {
            expect(isKeyboardElement(new TestElement(selector) as unknown as EventTarget)).toBe(true);
        }
        expect(isKeyboardElement(new TestElement("button") as unknown as EventTarget)).toBe(false);
        expect(isKeyboardElement(null)).toBe(false);
    });
});
