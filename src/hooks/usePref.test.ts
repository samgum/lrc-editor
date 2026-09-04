import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());

describe("Huhu language preference", () => {
    it.each([
        ["{}", "auto"],
        ["{\"huhuAlignmentLanguage\":\"auto\"}", "auto"],
        ["{\"huhuAlignmentLanguage\":\"en\"}", "en"],
        ["{\"huhuAlignmentLanguage\":\"invalid\"}", "auto"],
    ])("initializes %s as %s", async (stored, expected) => {
        vi.stubGlobal("i18n", { langCodeList: ["en-US"] });
        vi.stubGlobal("navigator", { language: "en-US", languages: ["en-US"] });
        const { usePref } = await import("./usePref.js");
        const Preference = () => {
            const [state] = usePref(() => stored);
            return createElement("span", null, state.huhuAlignmentLanguage);
        };
        expect(renderToStaticMarkup(createElement(Preference))).toBe(`<span>${expected}</span>`);
    });
});
