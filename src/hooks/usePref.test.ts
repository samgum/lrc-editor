import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());

describe("usePref", () => {
    it("normalizes regional browser locales and sanitizes corrupted stored preferences", async () => {
        vi.stubGlobal("i18n", {
            langCodeList: ["en-US", "ja", "ko-KR", "pl-PL", "pt-BR", "sk-SK", "zh-CN", "zh-HK", "zh-TW"],
        });
        vi.stubGlobal("navigator", { language: "ja-JP", languages: ["ja-JP", "en-US"] });
        const { usePref } = await import("./usePref.js");
        const BrowserDetected = () => {
            const [state] = usePref(() => "{}");
            return createElement("span", null, state.lang);
        };
        expect(renderToStaticMarkup(createElement(BrowserDetected))).toBe("<span>ja</span>");

        const Corrupted = () => {
            const [state] = usePref(() =>
                JSON.stringify({
                    lang: "fr-FR",
                    fixed: 99,
                    spaceStart: 1e9,
                    themeColor: "not-a-hex",
                })
            );
            return createElement("span", null, `${state.lang}:${state.fixed}:${state.spaceStart}:${state.themeColor}`);
        };
        expect(renderToStaticMarkup(createElement(Corrupted))).toBe("<span>en-US:3:16:#f58ea8</span>");
    });
});
