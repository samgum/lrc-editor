import BRAND from "#const/brand.json" assert { type: "json" };
import ROUTER from "#const/router.json" assert { type: "json" };
import { useContext, useEffect, useState } from "react";
import { useKeyBindings } from "../hooks/useKeyBindings.js";
import { ThemeMode } from "../hooks/usePref.js";
import { InputAction } from "../utils/input-action.js";
import { isKeyboardElement } from "../utils/is-keyboard-element.js";
import { getMatchedAction } from "../utils/keybindings.js";
import { prependHash } from "../utils/router.js";
import { appContext, ChangBits } from "./app.context.js";
import {
    BrandSVG,
    EditorSVG,
    KeyBindingsSVG,
    MoonSVG,
    PreferencesSVG,
    SunSVG,
    SynchronizerSVG,
    UtilitySVG,
} from "./svg.js";

export const Header: React.FC = () => {
    const { lang, prefDispatch, prefState } = useContext(appContext, ChangBits.lang | ChangBits.prefState);
    const keyBindings = useKeyBindings();
    const [path, setPath] = useState(location.hash.slice(1) || ROUTER.home);
    const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const darkMode = prefState.themeMode === ThemeMode.dark || (prefState.themeMode === ThemeMode.auto && systemDark);

    const toggleTheme = (): void => {
        prefDispatch({ type: "themeMode", payload: darkMode ? ThemeMode.light : ThemeMode.dark });
    };

    useEffect(() => {
        const onHashChange = (): void => setPath(location.hash.slice(1) || ROUTER.home);
        window.addEventListener("hashchange", onHashChange);
        return () => window.removeEventListener("hashchange", onHashChange);
    }, []);

    useEffect(() => {
        const onKeyDown = (ev: KeyboardEvent): void => {
            if (!isKeyboardElement(ev.target) && getMatchedAction(ev, keyBindings) === InputAction.ShowHelp) {
                ev.preventDefault();
                location.hash = ROUTER.home;
            }
        };
        document.addEventListener("keydown", onKeyDown);
        return () => document.removeEventListener("keydown", onKeyDown);
    }, [keyBindings]);

    const navigation = [
        { path: ROUTER.editor, label: lang.header.editor, icon: <EditorSVG /> },
        { path: ROUTER.synchronizer, label: lang.header.synchronizer, icon: <SynchronizerSVG /> },
        { path: ROUTER.tools, label: lang.header.tools, icon: <UtilitySVG /> },
        { path: ROUTER.preferences, label: lang.header.preferences, icon: <PreferencesSVG /> },
        { path: ROUTER.keybindings, label: lang.header.keybindings, icon: <KeyBindingsSVG /> },
    ];

    return (
        <header className="app-header">
            <a id={ROUTER.home} className="app-title" title={lang.header.home} href={prependHash(ROUTER.home)}>
                <span className="app-brand-mark">
                    <BrandSVG />
                </span>
                <span className="app-title-copy">
                    <strong>{BRAND.name}</strong>
                </span>
            </a>
            <nav className="app-nav" aria-label={BRAND.name}>
                {navigation.map((item) => (
                    <a
                        id={item.path}
                        className="app-tab"
                        title={item.label}
                        href={prependHash(item.path)}
                        aria-current={path === item.path ? "page" : undefined}
                        key={item.path}
                    >
                        {item.icon}
                        <span className="app-tab-label">{item.label}</span>
                    </a>
                ))}
            </nav>
            <button
                className="app-theme-toggle"
                type="button"
                title={darkMode ? lang.preferences.themeMode.light : lang.preferences.themeMode.dark}
                aria-label={darkMode ? lang.preferences.themeMode.light : lang.preferences.themeMode.dark}
                onClick={toggleTheme}
            >
                {darkMode ? <SunSVG /> : <MoonSVG />}
            </button>
        </header>
    );
};
