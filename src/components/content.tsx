import LSK from "#const/local_key.json" assert { type: "json" };
import ROUTER from "#const/router.json" assert { type: "json" };
import SSK from "#const/session_key.json" assert { type: "json" };
import STRINGS from "#const/strings.json" assert { type: "json" };
import { stringify } from "@lrc-maker/lrc-parser";
import { type JSX, lazy, Suspense, useContext, useEffect, useState } from "react";
import { ActionType as LrcActionType, useLrc } from "../hooks/useLrc.js";
import { ThemeMode } from "../hooks/usePref.js";
import { prependHash } from "../utils/router.js";
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
        const rgb = hex2rgb(prefState.themeColor);
        document.documentElement.style.setProperty("--theme-rgb", rgb.join(", "));

        // https://www.w3.org/TR/WCAG20/#contrast-ratiodef
        // const contrast = (rgb1, rgb2) => {
        //   const c1 = luminance(...rgb1) + 0.05;
        //   const c2 = luminance(...rgb2) + 0.05;
        //   return c1 > c2 ? c1 / c2 : c2 / c1;
        // };

        // c: color ; b: black; w: white;
        // if we need black text
        //
        // (lum(c) + 0.05) / (l(b) + 0.05) > (l(w) + 0.05) / (lum(c) + 0.05);
        // => (lum(c) + 0.05)^2 > (l(b) +0.05) * (l(w) + 0.05) = 1.05 * 0.05 = 0.0525

        const lum = luminance(...rgb);
        const con = lum + 0.05;
        const contrastColor = con * con > 0.0525 ? "var(--black)" : "var(--white)";
        document.documentElement.style.setProperty("--theme-contrast-color", contrastColor);
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

// https://www.w3.org/TR/WCAG20/#relativeluminancedef
const luminance = (...rgb: [number, number, number]): number => {
    return rgb
        .map((v) => v / 255)
        .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)))
        .reduce((p, c, i) => {
            return p + c * [0.2126, 0.7152, 0.0722][i];
        }, 0);
};

const hex2rgb = (hex: string): [number, number, number] => {
    hex = hex.slice(1);
    const value = Number.parseInt(hex, 16);
    const r = (value >> 0x10) & 0xff;
    const g = (value >> 0x08) & 0xff;
    const b = (value >> 0x00) & 0xff;
    return [r, g, b];
};
