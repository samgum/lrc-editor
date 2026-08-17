import featureTranslations from "#const/feature_translations.json" assert { type: "json" };
import { useCallback, useState } from "react";
import enUS from "../languages/en-US.json" assert { type: "json" };
import { languages } from "../languages/index.js";

export const useLang = (): [Language, (lang: string) => Promise<void>] => {
    const [value, setValue] = useState<Language>(enUS);

    const setLang = async (langCode: string): Promise<void> => {
        const l = await languages[`./${langCode}.json`]();
        const base = mergeLanguage(enUS, l);
        const features = featureTranslations[langCode as keyof typeof featureTranslations];
        setValue(features ? mergeLanguage(base, features) : base);
    };

    return [value, useCallback(async (lang: string) => setLang(lang), [])];
};

const mergeLanguage = <T>(fallback: T, selected: unknown): T => {
    if (!isRecord(fallback) || !isRecord(selected)) {
        return (selected ?? fallback) as T;
    }

    return Object.fromEntries(
        Object.entries(fallback).map(([key, value]) => [
            key,
            key in selected ? mergeLanguage(value, selected[key]) : value,
        ]),
    ) as T;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
