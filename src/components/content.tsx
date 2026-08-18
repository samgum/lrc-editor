import LSK from "#const/local_key.json" assert { type: "json" };
import ROUTER from "#const/router.json" assert { type: "json" };
import SSK from "#const/session_key.json" assert { type: "json" };
import STRINGS from "#const/strings.json" assert { type: "json" };
import { stringify } from "@lrc-maker/lrc-parser";
import { type JSX, lazy, Suspense, useContext, useEffect, useState } from "react";
import { ActionType as LrcActionType, useLrc } from "../hooks/useLrc.js";
import { ThemeMode } from "../hooks/usePref.js";
import { prependHash } from "../utils/router.js";
import { accessibleThemeForeground, hexToRgb, themeContrastColor } from "../utils/theme-color.js";
import { appContext, ChangBits } from "./app.context.js";
import { Home } from "./home.js";

const LazyEditor = lazy(async () =>
    import("./editor.js").then(({ Editor }) => {
        return { default: Editor };
    })
);

const LazySynchronizer = lazy(async () =>
    import("./synchronizer.js").then(({ Synchronizer }) => {
        return { default: Synchronizer };
    })
);

const LazyPreferences = lazy(async () =>
    import("./preferences.js").then(({ Preferences }) => {
        return { default: Preferences };
    })
);

const LazyKeyBindings = lazy(async () =>
    import("./keybindings.js").then(({ KeyBindingsPage }) => {
        return { default: KeyBindingsPage };
    })
);

const LazyTools = lazy(async () =>
    import("./tools.js").then(({ Tools }) => {
        return { default: Tools };
    })
);

export const Content: React.FC = () => {
    const { lang, prefState, trimOptions } = useContext(appContext, ChangBits.lang | ChangBits.prefState);

    const [path, setPath] = useState(location.hash);
    useEffect(() => {
        function onHashchange() {
            setPath(location.hash);
        }

        window.addEventListener("hashchange", onHashchange);

        return () => window.removeEventListener("hashchange", onHashchange);
    }, []);

    const [lrcState, lrcDispatch] = useLrc(() => {
        return {
            text: localStorage.getItem(LSK.lyric) || STRINGS.emptyString,
            options: trimOptions,
            select: Number.parseInt(sessionStorage.getItem(SSK.selectIndex)!, 10) || 0,
        };
    });

    useEffect(() => {
        function saveState(): void {
            lrcDispatch({
                type: LrcActionType.getState,
                payload: (lrc) => {
                    localStorage.setItem(LSK.lyric, stringify(lrc, prefState));
                    sessionStorage.setItem(SSK.selectIndex, lrc.selectIndex.toString());
                },
            });

            localStorage.setItem(LSK.preferences, JSON.stringify(prefState));
        }

        function onVisibilitychange() {
            if (document.hidden) {
                saveState();
            }
        }

        document.addEventListener("visibilitychange", onVisibilitychange);
        window.addEventListener("beforeunload", saveState);

        return () => {
            document.removeEventListener("visibilitychange", onVisibilitychange);
            window.removeEventListener("beforeunload", saveState);
        };
    }, [lrcDispatch, prefState]);

    useEffect(() => {
        function onDrop(ev: DragEvent) {
            const file = ev.dataTransfer?.files[0];
            if (file && (file.type.startsWith("text/") || /(?:\.lrc|\.txt)$/i.test(file.name))) {
                const fileReader = new FileReader();

                const onload = (): void => {
                    lrcDispatch({
                        type: LrcActionType.parse,
                        payload: { text: fileReader.result as string, options: trimOptions },
                    });
                };

                fileReader.addEventListener("load", onload, {
                    once: true,
                });

                location.hash = ROUTER.editor;

                fileReader.readAsText(file, "utf-8");
            }
        }
        document.documentElement.addEventListener("drop", onDrop);
        return () => document.documentElement.removeEventListener("drop", onDrop);
    }, [lrcDispatch, trimOptions]);

    useEffect(() => {
        const values = {
            [ThemeMode.auto]: "auto",
            [ThemeMode.light]: "light",
            [ThemeMode.dark]: "dark",
        } as const;

        document.documentElement.dataset.theme = values[prefState.themeMode];
    }, [prefState.themeMode]);

    useEffect(() => {
        const rgb = hexToRgb(prefState.themeColor);
        const lightForeground = accessibleThemeForeground(rgb, [255, 255, 255]);
        const darkForeground = accessibleThemeForeground(rgb, [25, 28, 35]);
        document.documentElement.style.setProperty("--theme-rgb", rgb.join(", "));
        document.documentElement.style.setProperty("--theme-foreground-light-rgb", lightForeground.join(", "));
        document.documentElement.style.setProperty("--theme-foreground-dark-rgb", darkForeground.join(", "));
        document.documentElement.style.setProperty("--theme-contrast-color", themeContrastColor(rgb));
    }, [prefState.themeColor]);

    const content = ((): JSX.Element => {
        switch (path.slice(1)) {
            case ROUTER.editor: {
                return <LazyEditor lrcState={lrcState} lrcDispatch={lrcDispatch} />;
            }

            case ROUTER.synchronizer: {
                if (lrcState.lyric.length === 0) {
                    return (
                        <section className="workspace-empty">
                            <h1>{lang.workspace.noLyrics}</h1>
                            <a className="button" href={prependHash(ROUTER.editor)}>{lang.workspace.openEditor}</a>
                        </section>
                    );
                }
                return <LazySynchronizer state={lrcState} dispatch={lrcDispatch} />;
            }

            case ROUTER.preferences: {
                return <LazyPreferences />;
            }

            case ROUTER.tools: {
                return <LazyTools state={lrcState} dispatch={lrcDispatch} />;
            }

            case ROUTER.keybindings: {
                return <LazyKeyBindings />;
            }
        }

        return <Home />;
    })();

    return (
        <main className="app-main">
            <Suspense
                fallback={
                    <div className="workspace-loading" aria-label={lang.workspace.loading}>
                        <span />
                    </div>
                }
            >
                {content}
            </Suspense>
        </main>
    );
};
