import { describe, expect, it } from "vitest";
import {
    detectHuhuAlignmentLanguage,
    normalizeHuhuLanguageSelection,
    resolveHuhuAlignmentLanguage,
} from "./huhu-language.js";

describe("Huhu automatic language selection", () => {
    it.each([
        ["愛してる\n君と一緒に", "ja"],
        ["愛してる\nHello world\n君とstay", "ja"],
        ["愛してる\nHello world\n君とstay\n会いたいtonight", "ja-en"],
        ["君とlove, stay, tonight", "ja"],
        ["爱着你\n一直在一起", "zh-hans-cn"],
        ["爱着你\nHello world\n与你stay", "zh-hans-cn"],
        ["爱着你\nHello world\n与你stay\n等你tonight", "zh-hans-cn-en"],
        ["This isn't gonna work, I know", "en"],
        ["I\n123\n🎵", "en"],
        ["漢字\nI'm here", "zh-hans-cn"],
        ["漢字\nI'm here\nYou are here\nStay", "zh-hans-cn-en"],
        ["かな中文\nI'm here\nYou are here\nStay", "ja-en"],
        ["爱着你\n与你A\n跟着B\n想你C", "zh-hans-cn"],
        ["あいう\nきみA\nきみB\nきみC", "ja"],
        ["あいう\nA\nB\nC", "ja-en"],
        ["爱着你\n想你can't\n为你I'm\n陪你we’re", "zh-hans-cn-en"],
        ["かな\n君はa-b\n君はx/y\n君はc3d", "ja"],
        ["かな\n君はlo-ve\n君はgo/go\n君はwe're", "ja-en"],
        ["ｶﾅ\nＨｅｌｌｏ\nＳｔａｙ\nＴｏｎｉｇｈｔ", "ja-en"],
        ["かな\n123 !!! 🎵\n🅰️ 🆘\nℹ️ ©️ ®️ ™️\n🇬🇧", "ja"],
        ["爱着你\n123 !!! 🎵\n🅰️ 🆘\nℹ️ ©️ ®️ ™️\n🇬🇧", "zh-hans-cn"],
        ["123 !!! 🎵\n🅰️ 🆘", "zh-hans-cn"],
        ["かな\nⅠ\nⅡ\nⅢ\nⒶ", "ja"],
        ["中文\nⅣ\nⅤ\nⅥ\nⒶ", "zh-hans-cn"],
        ["123 Ⅰ Ⅱ Ⅲ 𝟙 𝟚 𝟛 🆘", "zh-hans-cn"],
        ["君にstay\r君にlove\r君にkiss", "ja-en"],
        ["君にstay\r\n君にlove\r\n君にkiss", "ja-en"],
    ])("detects the specified language for %s", (lyrics, language) => {
        expect(detectHuhuAlignmentLanguage(lyrics)).toBe(language);
    });

    it("preserves manual overrides and defaults missing or invalid preferences to auto", () => {
        expect(normalizeHuhuLanguageSelection(undefined)).toBe("auto");
        expect(normalizeHuhuLanguageSelection("invalid")).toBe("auto");
        expect(normalizeHuhuLanguageSelection("ja")).toBe("ja");
        expect(resolveHuhuAlignmentLanguage("ja", "Hello world")).toBe("ja");
        expect(resolveHuhuAlignmentLanguage("auto", "Hello world")).toBe("en");
    });
});
