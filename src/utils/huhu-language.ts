export const huhuAlignmentLanguages = ["ja", "en", "ja-en", "zh-hans-cn", "zh-hans-cn-en"] as const;
export type HuhuAlignmentLanguage = typeof huhuAlignmentLanguages[number];
export type HuhuLanguageSelection = HuhuAlignmentLanguage | "auto";

export const normalizeHuhuLanguageSelection = (value: unknown): HuhuLanguageSelection =>
    value === "auto" || huhuAlignmentLanguages.includes(value as HuhuAlignmentLanguage)
        ? value as HuhuLanguageSelection
        : "auto";

export const detectHuhuAlignmentLanguage = (transcript: string): HuhuAlignmentLanguage => {
    const lines = transcript.split(/\r\n|\n|\r/u).map((line) =>
        line.replace(/[\p{N}\p{S}\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}]/gu, " ").normalize(
            "NFKC",
        )
    );
    const kana = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
    const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
    const hasKana = lines.some((line) => kana.test(line));
    const hasCjk = lines.some((line) => cjk.test(line));
    const hasEnglish = lines.some((line) => /[a-z]/iu.test(line));
    if (hasEnglish && !hasCjk) return "en";

    const englishLineCount = lines.filter((line) => {
        if (!cjk.test(line) && /[a-z]/iu.test(line)) return true;
        const words = line.match(/[a-z]+(?:['’][a-z]+)*/giu) || [];
        return words.some((word) => word.replace(/['’]/gu, "").length > 1);
    }).length;
    if (hasKana) return englishLineCount >= 3 ? "ja-en" : "ja";
    return englishLineCount >= 3 ? "zh-hans-cn-en" : "zh-hans-cn";
};

export const resolveHuhuAlignmentLanguage = (
    selection: HuhuLanguageSelection,
    transcript: string,
): HuhuAlignmentLanguage => selection === "auto" ? detectHuhuAlignmentLanguage(transcript) : selection;
