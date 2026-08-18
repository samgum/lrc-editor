import ROUTER from "#const/router.json" assert { type: "json" };
import SSK from "#const/session_key.json" assert { type: "json" };
import { type State as LrcState, stringify } from "@lrc-maker/lrc-parser";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { Action as LrcAction } from "../hooks/useLrc.js";
import { ActionType as LrcActionType } from "../hooks/useLrc.js";
import { createUntimedTranscript, validateAlignedLyrics } from "../utils/ai-alignment-result.js";
import { getAlignmentMediaSource } from "../utils/alignment-media.js";
import {
    LocalAiAlignmentError,
    type LocalAlignmentProgress,
    runLocalAiAlignment,
} from "../utils/local-ai-alignment.js";
import { lrcFileName } from "../utils/lrc-file-name.js";
import { prependHash } from "../utils/router.js";
import { appContext } from "./app.context.js";
import { AiAlignSVG, CopySVG, DownloadSVG, OpenFileSVG, UtilitySVG } from "./svg.js";
import { toastPubSub } from "./toast.js";

const disableCheck = {
    autoCapitalize: "none",
    autoComplete: "off",
    autoCorrect: "off",
    spellCheck: false,
};

type HTMLInputLikeElement = HTMLInputElement & HTMLTextAreaElement;

interface AiAlignmentState extends LocalAlignmentProgress {
    visible: boolean;
    error?: string;
    showInstall?: boolean;
}

type UseDefaultValue<T = React.RefObject<HTMLInputLikeElement>> = (
    defaultValue: string,
    ref?: T,
) => { defaultValue: string; ref: T };

const useDefaultValue: UseDefaultValue = (defaultValue, ref) => {
    const or = <T, K>(a: T, b: K): NonNullable<T> | K => a ?? b;

    const $ref = or(ref, useRef<HTMLInputLikeElement>(null));

    useEffect(() => {
        if ($ref.current) {
            $ref.current.value = defaultValue;
        }
    }, [defaultValue, $ref]);
    return { ref: $ref, defaultValue };
};

export const Editor: React.FC<{
    lrcState: LrcState;
    lrcDispatch: React.Dispatch<LrcAction>;
}> = ({ lrcState, lrcDispatch }) => {
    const { prefState, prefDispatch, lang, trimOptions } = useContext(appContext);

    const parse = useCallback(
        (ev: React.FocusEvent<HTMLTextAreaElement>) => {
            lrcDispatch({
                type: LrcActionType.parse,
                payload: { text: ev.target.value, options: trimOptions },
            });
        },
        [lrcDispatch, trimOptions],
    );

    const setInfo = useCallback(
        (ev: React.FocusEvent<HTMLInputElement>) => {
            const { name, value } = ev.target;
            lrcDispatch({
                type: LrcActionType.info,
                payload: { name, value },
            });
        },
        [lrcDispatch],
    );

    const text = stringify(lrcState, prefState);

    const details = useRef<HTMLDetailsElement>(null);

    const onDetailsToggle = useCallback(() => {
        sessionStorage.setItem(SSK.editorDetailsOpen, details.current!.open.toString());
    }, []);

    const detailsOpened = useMemo(() => {
        return sessionStorage.getItem(SSK.editorDetailsOpen) === "true";
    }, []);

    const textarea = useRef<HTMLInputLikeElement>(null);
    const [href, setHref] = useState<string | undefined>(undefined);
    const activeAlignment = useRef<Promise<void> | null>(null);
    const [aiState, setAiState] = useState<AiAlignmentState | null>(null);

    const onDownloadClick = useCallback(() => {
        setHref((url) => {
            if (url) {
                URL.revokeObjectURL(url);
            }

            return URL.createObjectURL(
                new Blob([textarea.current!.value], {
                    type: "text/plain;charset=UTF-8",
                }),
            );
        });
    }, []);

    const onTextFileUpload = useCallback(
        (ev: React.ChangeEvent<HTMLInputElement>) => {
            if (ev.target.files === null || ev.target.files.length === 0) {
                return;
            }

            const fileReader = new FileReader();
            fileReader.addEventListener("load", () => {
                lrcDispatch({
                    type: LrcActionType.parse,
                    payload: { text: fileReader.result as string, options: trimOptions },
                });
            });
            fileReader.readAsText(ev.target.files[0], "UTF-8");
        },
        [lrcDispatch, trimOptions],
    );

    const onCopyClick = useCallback(() => {
        textarea.current?.select();
        document.execCommand("copy");
    }, []);

    const downloadName = useMemo(() => lrcFileName(lrcState.info), [lrcState.info]);

    const statusText = useCallback((progress: LocalAlignmentProgress): string => {
        switch (progress.phase) {
            case "connecting":
                return lang.editor.aiConnecting;
            case "uploading":
                return lang.editor.aiUploading;
            case "queued":
                return lang.editor.aiQueued;
            case "running":
                return lang.editor.aiRunning;
            case "complete":
                return lang.editor.aiComplete;
        }
    }, [lang.editor]);

    const alignmentErrorText = useCallback((error: unknown): string => {
        if (error instanceof LocalAiAlignmentError) {
            if (error.code === "missing") return lang.editor.aiExtensionMissing;
            if (error.code === "outdated") return lang.editor.aiExtensionOutdated;
            if (error.code === "not-running") return lang.editor.aiServiceMissing;
            if (error.code === "busy") return lang.editor.aiDuplicate;
        }
        return lang.editor.aiFailed;
    }, [lang.editor]);

    const onAiAlign = useCallback(() => {
        if (activeAlignment.current) {
            setAiState((state) => state ? { ...state, visible: true } : state);
            toastPubSub.pub({ type: "info", text: lang.editor.aiDuplicate });
            return;
        }
        const operation = (async (): Promise<void> => {
            const currentText = textarea.current ? textarea.current.value : text;
            const transcript = createUntimedTranscript(currentText, trimOptions);
            if (!transcript.split(/\r\n|\n|\r/).some((line) => line.trim())) {
                toastPubSub.pub({ type: "warning", text: lang.editor.aiNoLyrics });
                return;
            }
            const initial: LocalAlignmentProgress = { phase: "connecting", progress: 0.01 };
            setAiState({ ...initial, visible: true });
            let media: { blob: Blob; name: string };
            try {
                media = await getAlignmentMediaSource();
            } catch {
                setAiState(null);
                toastPubSub.pub({ type: "warning", text: lang.editor.aiNoMedia });
                return;
            }

            try {
                const alignedLrc = await runLocalAiAlignment({
                    audio: media.blob,
                    audioName: media.name,
                    transcript,
                    precision: prefState.fixed === 2 ? 2 : 3,
                    onProgress: (progress) => setAiState({ ...progress, visible: true }),
                });
                const lyric = validateAlignedLyrics(transcript, alignedLrc, trimOptions);
                lrcDispatch({ type: LrcActionType.replaceLyrics, payload: lyric });
                setAiState({ phase: "complete", progress: 1, visible: true });
                toastPubSub.pub({ type: "success", text: lang.editor.aiComplete });
            } catch (error) {
                const message = alignmentErrorText(error);
                const showInstall = error instanceof LocalAiAlignmentError
                    && ["missing", "outdated", "not-running"].includes(error.code);
                setAiState((state) => ({
                    phase: state?.phase || "connecting",
                    progress: state?.progress || 0,
                    visible: true,
                    error: message,
                    showInstall,
                }));
                toastPubSub.pub({ type: "warning", text: message });
            }
        })().finally(() => {
            activeAlignment.current = null;
        });
        activeAlignment.current = operation;
    }, [alignmentErrorText, lang.editor, lrcDispatch, prefState.fixed, text, trimOptions]);

    const onAiAlignClick = useCallback(() => {
        if (!prefState.aiAlignmentEnabled) {
            prefDispatch({ type: "aiAlignmentEnabled", payload: true });
        }
        onAiAlign();
    }, [onAiAlign, prefDispatch, prefState.aiAlignmentEnabled]);

    const aiStatus = aiState && !aiState.error ? statusText(aiState) : aiState?.error;

    return (
        <div className="app-editor">
            <header className="editor-commandbar ai-enabled">
                <details ref={details} open={detailsOpened} onToggle={onDetailsToggle}>
                    <summary>{lang.editor.metaInfo}</summary>
                    <section className="app-editor-infobox" onBlur={setInfo}>
                        <label htmlFor="info-ti">
                            <span>{lang.editor.title}</span>
                            <input
                                id="info-ti"
                                name="ti"
                                {...disableCheck}
                                {...useDefaultValue(lrcState.info.get("ti") || "")}
                            />
                        </label>
                        <label htmlFor="info-ar">
                            <span>{lang.editor.artist}</span>
                            <input
                                id="info-ar"
                                name="ar"
                                {...disableCheck}
                                {...useDefaultValue(lrcState.info.get("ar") || "")}
                            />
                        </label>
                        <label htmlFor="info-al">
                            <span>{lang.editor.album}</span>
                            <input
                                id="info-al"
                                name="al"
                                {...disableCheck}
                                {...useDefaultValue(lrcState.info.get("al") || "")}
                            />
                        </label>
                    </section>
                </details>

                <section className="editor-tools">
                    <button
                        className={`editor-tools-item ripple ai-align-button${
                            prefState.aiAlignmentEnabled ? "" : " is-off"
                        }`}
                        title={prefState.aiAlignmentEnabled ? lang.editor.aiAlign : lang.editor.aiEnableAndAlign}
                        aria-label={prefState.aiAlignmentEnabled ? lang.editor.aiAlign : lang.editor.aiEnableAndAlign}
                        aria-pressed={prefState.aiAlignmentEnabled}
                        onClick={onAiAlignClick}
                    >
                        <AiAlignSVG />
                        <span>AI</span>
                    </button>
                    <label className="editor-tools-item ripple" title={lang.editor.uploadText}>
                        <input hidden={true} type="file" accept="text/*, .txt, .lrc" onChange={onTextFileUpload} />
                        <OpenFileSVG />
                    </label>
                    <button className="editor-tools-item ripple" title={lang.editor.copyText} onClick={onCopyClick}>
                        <CopySVG />
                    </button>
                    <a
                        className="editor-tools-item ripple"
                        title={lang.editor.downloadText}
                        href={href}
                        onClick={onDownloadClick}
                        download={downloadName}
                    >
                        <DownloadSVG />
                    </a>

                    <a title={lang.editor.utils} href={prependHash(ROUTER.tools)} className="editor-tools-item ripple">
                        <UtilitySVG />
                    </a>
                </section>
            </header>

            <textarea
                className="app-textarea"
                aria-label="lrc input here"
                onBlur={parse}
                {...disableCheck}
                {...useDefaultValue(text, textarea)}
            />
            {aiState?.visible && (
                <dialog className="ai-align-dialog" open={true} aria-labelledby="ai-align-title">
                    <article>
                        <header>
                            <h2 id="ai-align-title">{lang.editor.aiTitle}</h2>
                            <button
                                type="button"
                                onClick={() =>
                                    setAiState((state) =>
                                        state && {
                                            ...state,
                                            visible: false,
                                        }
                                    )}
                            >
                                {lang.editor.aiClose}
                            </button>
                        </header>
                        <progress max={1} value={aiState.progress} />
                        <p>{aiStatus}</p>
                        {aiState.showInstall && (
                            <a
                                href="https://github.com/samgum/lrc-editor/tree/main/companion"
                                target="_blank"
                                rel="noopener noreferrer"
                            >
                                {lang.editor.aiInstall}
                            </a>
                        )}
                    </article>
                </dialog>
            )}
        </div>
    );
};
