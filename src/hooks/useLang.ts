import { useCallback, useRef, useState } from "react";
import enUS from "../languages/en-US.json" assert { type: "json" };
import { languages } from "../languages/index.js";

export const useLang = (): [Language, (lang: string) => Promise<void>] => {
    const [value, setValue] = useState<Language>(enUS);
    const requestIdRef = useRef(0);

    const setLang = useCallback(async (langCode: string): Promise<void> => {
        const requestId = ++requestIdRef.current;
        if (langCode === "en-US") {
            setValue(enUS);
            return;
        }
        const loader = languages[`./${langCode}.json`];
        if (!loader) {
            setValue(enUS);
            return;
        }
        try {
            const loaded = await loader();
            if (requestIdRef.current !== requestId) return;
            setValue(mergeLanguage(enUS, loaded));
        } catch {
            if (requestIdRef.current !== requestId) return;
            setValue(enUS);
        }
    }, []);

    return [value, setLang];
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
