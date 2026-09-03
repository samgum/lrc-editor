import LSK from "#const/local_key.json" assert { type: "json" };
import ROUTER from "#const/router.json" assert { type: "json" };
import SSK from "#const/session_key.json" assert { type: "json" };
import STRINGS from "#const/strings.json" assert { type: "json" };
import { parser, stringify } from "@lrc-maker/lrc-parser";
import { type JSX, lazy, Suspense, useCallback, useContext, useEffect, useRef, useState } from "react";
import { AdvancedActionType, type AdvancedLyricsAction, useAdvancedLyrics } from "../hooks/useAdvancedLyrics.js";
import { ActionType as LrcActionType, useLrc } from "../hooks/useLrc.js";
import { ThemeMode } from "../hooks/usePref.js";
import {
    createWordTimedDocument,
    documentToBasicLyrics,
    hasWordTiming,
    type LyricsWorkspaceMode,
    parseLyricBytes,
    reconcileAdvancedDocument,
    toLineLrc,
} from "../utils/advanced-lyrics.js";
import { prependHash } from "../utils/router.js";
import { accessibleThemeForeground, hexToRgb, themeContrastColor } from "../utils/theme-color.js";
import { appContext, ChangBits } from "./app.context.js";
import { Home } from "./home.js";
import { toastPubSub } from "./toast.js";

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
    const { lang, prefState, prefDispatch, trimOptions } = useContext(
        appContext,
        ChangBits.lang | ChangBits.prefState,
    );

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
    const [advancedState, advancedDispatch] = useAdvancedLyrics(
        localStorage.getItem(LSK.advancedLyrics) || STRINGS.emptyString,
    );
    const [editorTimingMode, setEditorTimingMode] = useState<LyricsWorkspaceMode>(() =>
        sessionStorage.getItem(SSK.editorTimingMode) === "word" ? "word" : "line"
    );
    const [wordTimingOffer, setWordTimingOffer] = useState(false);
    const advancedNeedsBasicSync = useRef(false);
    const cursorRestored = useRef(false);

    useEffect(() => {
        if (cursorRestored.current) return;
        cursorRestored.current = true;
        try {
            const cursor = JSON.parse(sessionStorage.getItem(SSK.advancedWordCursor) || "null") as {
                lineIndex?: unknown;
                wordIndex?: unknown;
            } | null;
            if (cursor && Number.isInteger(cursor.lineIndex) && Number.isInteger(cursor.wordIndex)) {
                advancedDispatch({
                    type: AdvancedActionType.select,
                    payload: { lineIndex: Number(cursor.lineIndex), wordIndex: Number(cursor.wordIndex) },
                });
            }
        } catch {
            sessionStorage.removeItem(SSK.advancedWordCursor);
        }
    }, [advancedDispatch]);

    useEffect(() => {
        const saveTimer = setTimeout(() => {
            if (advancedState.document) {
                localStorage.setItem(LSK.advancedLyrics, JSON.stringify(advancedState.document));
            }
            sessionStorage.setItem(SSK.advancedWordCursor, JSON.stringify(advancedState.cursor));
        }, 120);
        return () => clearTimeout(saveTimer);
    }, [advancedState.cursor, advancedState.document]);

    useEffect(() => {
        const saveTimer = setTimeout(() => {
            localStorage.setItem(LSK.preferences, JSON.stringify(prefState));
        }, 120);
        return () => clearTimeout(saveTimer);
    }, [prefState]);

    const updateAdvanced = useCallback((action: AdvancedLyricsAction) => {
        if (
            action.type !== AdvancedActionType.load
            && action.type !== AdvancedActionType.reconcile
            && action.type !== AdvancedActionType.ensureWordMode
            && action.type !== AdvancedActionType.select
        ) {
            advancedNeedsBasicSync.current = true;
        }
        advancedDispatch(action);
    }, [advancedDispatch]);

    useEffect(() => {
        if (!advancedNeedsBasicSync.current || !advancedState.document) return;
        advancedNeedsBasicSync.current = false;
        lrcDispatch({
            type: LrcActionType.replaceLyrics,
            payload: documentToBasicLyrics(advancedState.document),
        });
    }, [advancedState.document, lrcDispatch]);

    const ensureWordMode = useCallback((target: "editor" | "synchronizer") => {
        const hasExistingWordProgress = hasWordTiming(advancedState.document);
        if (!prefState.advancedLyricsEnabled) {
            prefDispatch({ type: "advancedLyricsEnabled", payload: true });
        }
        advancedDispatch({
            type: AdvancedActionType.ensureWordMode,
            payload: { lines: lrcState.lyric, metadata: lrcState.info },
        });
        if (!hasExistingWordProgress) {
            advancedDispatch({
                type: AdvancedActionType.select,
                payload: {
                    lineIndex: lrcState.selectIndex,
                    wordIndex: advancedState.cursor.lineIndex === lrcState.selectIndex
                        ? advancedState.cursor.wordIndex
                        : 0,
                },
            });
        }
        if (target === "editor") setEditorTimingMode("word");
    }, [
        advancedDispatch,
        advancedState.cursor,
        advancedState.document,
        lrcState.info,
        lrcState.lyric,
        lrcState.selectIndex,
        prefDispatch,
        prefState.advancedLyricsEnabled,
    ]);

    const changeEditorTimingMode = useCallback((mode: LyricsWorkspaceMode) => {
        if (mode === "word") ensureWordMode("editor");
        else setEditorTimingMode("line");
    }, [ensureWordMode]);

    useEffect(() => {
        if (
            path.slice(1) === ROUTER.wordSynchronizer
            && prefState.advancedLyricsEnabled
            && advancedState.document?.timingMode !== "word"
        ) {
            ensureWordMode("synchronizer");
        }
    }, [advancedState.document?.timingMode, ensureWordMode, path, prefState.advancedLyricsEnabled]);

    const importLyricsFile = useCallback(async (file: File): Promise<void> => {
        try {
            const document = parseLyricBytes(file.name, new Uint8Array(await file.arrayBuffer()));
            lrcDispatch({
                type: LrcActionType.parse,
                payload: { text: toLineLrc(document, prefState.fixed), options: trimOptions },
            });
            advancedDispatch({ type: AdvancedActionType.load, payload: document });
            setEditorTimingMode("line");
            setWordTimingOffer(hasWordTiming(document));
            location.hash = ROUTER.editor;
            toastPubSub.pub({
                type: "success",
                text: lang.advancedLyrics.importComplete.replace("%s", document.sourceFormat.toUpperCase()),
            });
        } catch {
            toastPubSub.pub({ type: "warning", text: lang.advancedLyrics.importFailed });
        }
    }, [advancedDispatch, lang.advancedLyrics, lrcDispatch, prefState.fixed, trimOptions]);

    const reconcileBasicText = useCallback((text: string) => {
        const parsed = parser(text, trimOptions);
        advancedDispatch({
            type: AdvancedActionType.reconcile,
            payload: reconcileAdvancedDocument(advancedState.document, parsed.lyric, parsed.info),
        });
    }, [advancedDispatch, advancedState.document, trimOptions]);

    const reconcileMetadata = useCallback((name: string, value: string) => {
        if (!advancedState.document) return;
        const metadata = new Map(lrcState.info);
        const normalized = value.trim();
        if (normalized) metadata.set(name, normalized);
        else metadata.delete(name);
        advancedDispatch({
            type: AdvancedActionType.reconcile,
            payload: reconcileAdvancedDocument(advancedState.document, lrcState.lyric, metadata),
        });
    }, [advancedDispatch, advancedState.document, lrcState.info, lrcState.lyric]);

    const resetAdvancedWordTiming = useCallback((lyrics: typeof lrcState.lyric) => {
        if (!advancedState.document) return;
        advancedDispatch({
            type: AdvancedActionType.load,
            payload: createWordTimedDocument(lyrics, lrcState.info),
        });
    }, [advancedDispatch, advancedState.document, lrcState.info]);

    useEffect(() => {
        sessionStorage.setItem(SSK.editorTimingMode, editorTimingMode);
    }, [editorTimingMode]);

    useEffect(() => {
        if (!prefState.advancedLyricsEnabled) {
            setEditorTimingMode("line");
        }
    }, [prefState.advancedLyricsEnabled]);

    useEffect(() => {
        function saveState(): void {
            lrcDispatch({
                type: LrcActionType.getState,
                payload: (lrc) => {
                    localStorage.setItem(LSK.lyric, stringify(lrc, prefState));
                    sessionStorage.setItem(SSK.selectIndex, lrc.selectIndex.toString());
                },
            });

            if (advancedState.document) {
                localStorage.setItem(LSK.advancedLyrics, JSON.stringify(advancedState.document));
            } else {
                localStorage.removeItem(LSK.advancedLyrics);
            }
            sessionStorage.setItem(SSK.advancedWordCursor, JSON.stringify(advancedState.cursor));

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
    }, [advancedState.document, lrcDispatch, prefState]);

    useEffect(() => {
        function onDrop(ev: DragEvent) {
            const file = ev.dataTransfer?.files[0];
            if (file && (file.type.startsWith("text/") || /(?:\.lrc|\.krc|\.ttml|\.srt|\.txt)$/i.test(file.name))) {
                void importLyricsFile(file);
            }
        }
        document.documentElement.addEventListener("drop", onDrop);
        return () => document.documentElement.removeEventListener("drop", onDrop);
    }, [importLyricsFile]);

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
                return (
                    <LazyEditor
                        lrcState={lrcState}
                        lrcDispatch={lrcDispatch}
                        advancedState={advancedState}
                        advancedDispatch={updateAdvanced}
                        timingMode={editorTimingMode}
                        onTimingModeChange={changeEditorTimingMode}
                        onImportFile={importLyricsFile}
                        onBasicTextParsed={reconcileBasicText}
                        onMetadataChanged={reconcileMetadata}
                        onBasicLyricsReplaced={resetAdvancedWordTiming}
                        wordTimingOffer={wordTimingOffer}
                        onAcceptWordTiming={() => {
                            setWordTimingOffer(false);
                            ensureWordMode("editor");
                        }}
                        onDismissWordTiming={() => setWordTimingOffer(false)}
                    />
                );
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
                return (
                    <LazySynchronizer
                        state={lrcState}
                        dispatch={lrcDispatch}
                        advancedState={advancedState}
                        advancedDispatch={updateAdvanced}
                        timingMode="line"
                    />
                );
            }

            case ROUTER.wordSynchronizer: {
                if (!prefState.advancedLyricsEnabled) {
                    return (
                        <section className="workspace-empty">
                            <h1>{lang.advancedLyrics.wordTimingDisabled}</h1>
                            <a className="button" href={prependHash(ROUTER.preferences)}>
                                {lang.header.preferences}
                            </a>
                        </section>
                    );
                }
                if (lrcState.lyric.length === 0) {
                    return (
                        <section className="workspace-empty">
                            <h1>{lang.workspace.noLyrics}</h1>
                            <a className="button" href={prependHash(ROUTER.editor)}>{lang.workspace.openEditor}</a>
                        </section>
                    );
                }
                if (advancedState.document?.timingMode !== "word") {
                    return (
                        <div className="workspace-loading" aria-label={lang.workspace.loading}>
                            <span />
                        </div>
                    );
                }
                return (
                    <LazySynchronizer
                        state={lrcState}
                        dispatch={lrcDispatch}
                        advancedState={advancedState}
                        advancedDispatch={updateAdvanced}
                        timingMode="word"
                    />
                );
            }

            case ROUTER.preferences: {
                return <LazyPreferences />;
            }

            case ROUTER.tools: {
                return (
                    <LazyTools
                        state={lrcState}
                        dispatch={lrcDispatch}
                        advancedDocument={advancedState.document}
                        onConversionApplied={(document) =>
                            advancedDispatch({ type: AdvancedActionType.load, payload: document })}
                    />
                );
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
