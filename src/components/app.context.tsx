import BRAND from "#const/brand.json" assert { type: "json" };
import LSK from "#const/local_key.json" assert { type: "json" };
import STRINGS from "#const/strings.json" assert { type: "json" };
import type { TrimOptios } from "@lrc-maker/lrc-parser";
import { createContext, useEffect, useMemo } from "react";
import { KeyBindingsContext } from "../hooks/useKeyBindings.js";
import { useLang } from "../hooks/useLang.js";
import { type Action as PrefAction, type State as PrefState, usePref } from "../hooks/usePref.js";
import enUS from "../languages/en-US.json" assert { type: "json" };
import { toastPubSub } from "./toast.js";

interface IAppContext {
    lang: Language;
    prefState: PrefState;
    prefDispatch: React.Dispatch<PrefAction>;
    trimOptions: Required<TrimOptios>;
}

export const langContext = createContext<Language>(enUS);
export const appContext = createContext<IAppContext>(undefined as unknown as IAppContext);

export const AppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [prefState, prefDispatch] = usePref(() => localStorage.getItem(LSK.preferences) || STRINGS.emptyString);

    const [lang, setLang] = useLang();

    useEffect(() => {
        setLang(prefState.lang).catch((error: Error) => {
            toastPubSub.pub({
                type: "warning",
                text: error.message,
            });
        });
    }, [prefState.lang, setLang]);

    useEffect(() => {
        document.title = location.hostname === "lrc.sgmy.org" ? BRAND.fullname : BRAND.name;
        document.documentElement.lang = prefState.lang;
    }, [prefState.lang]);

    const value = useMemo(() => {
        return {
            lang,
            prefState,
            prefDispatch,
            trimOptions: {
                trimStart: prefState.spaceStart >= 0,
                trimEnd: prefState.spaceEnd >= 0,
            },
        };
    }, [lang, prefDispatch, prefState]);

    return (
        <langContext.Provider value={lang}>
            <appContext.Provider value={value}>
                <KeyBindingsContext.Provider value={prefState.keyBindings}>{children}</KeyBindingsContext.Provider>
            </appContext.Provider>
        </langContext.Provider>
    );
};
