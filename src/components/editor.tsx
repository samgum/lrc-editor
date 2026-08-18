import BRAND from "#const/brand.json" assert { type: "json" };
import ROUTER from "#const/router.json" assert { type: "json" };
import SSK from "#const/session_key.json" assert { type: "json" };
import { type State as LrcState, stringify } from "@lrc-maker/lrc-parser";
import { useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Action as LrcAction } from "../hooks/useLrc.js";
import { ActionType as LrcActionType } from "../hooks/useLrc.js";
import { createUntimedTranscript, validateAlignedLyrics } from "../utils/ai-alignment-result.js";
import {
    getAiAlignmentSessionSnapshot,
    startAiAlignmentSession,
    stopAiAlignmentSession,
    subscribeAiAlignmentSession,
    updateAiAlignmentSessionState,
} from "../utils/ai-alignment-session.js";
import { aiEngineDownloadUrl } from "../utils/ai-engine-download.js";
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
    const aiSession = useSyncExternalStore(
        subscribeAiAlignmentSession,
        getAiAlignmentSessionSnapshot,
        getAiAlignmentSessionSnapshot,
    );
    const aiState = aiSession.state;

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
            case "stopping":
                return lang.editor.aiStopping;
            case "stopped":
                return lang.editor.aiStopped;
            case "cleaning":
                return lang.editor.aiCleaning;
            case "complete":
                return lang.editor.aiComplete;
        }
    }, [lang.editor]);

    const alignmentErrorText = useCallback((error: unknown): string => {
        if (error instanceof LocalAiAlignmentError) {
            if (error.code === "missing") return lang.editor.aiExtensionMissing;
            if (error.code === "outdated") return lang.editor.aiExtensionOutdated;
            if (error.code === "mobile") return lang.editor.aiMobileDesktopRequired;
            if (error.code === "not-running") return lang.editor.aiServiceMissing;
            if (error.code === "busy") return lang.editor.aiDuplicate;
        }
        return lang.editor.aiFailed;
    }, [lang.editor]);

    const onAiAlign = useCallback(() => {
        if (aiSession.active) {
            updateAiAlignmentSessionState((state) => state ? { ...state, visible: true } : state);
            toastPubSub.pub({ type: "info", text: lang.editor.aiDuplicate });
            return;
        }
        const started = startAiAlignmentSession(async (signal): Promise<void> => {
            const currentText = textarea.current ? textarea.current.value : text;
            const transcript = createUntimedTranscript(currentText, trimOptions);
            if (!transcript.split(/\r\n|\n|\r/).some((line) => line.trim())) {
                toastPubSub.pub({ type: "warning", text: lang.editor.aiNoLyrics });
                return;
            }
            const initial: LocalAlignmentProgress = { phase: "connecting", progress: 0.01 };
            updateAiAlignmentSessionState(() => ({ ...initial, visible: true }));
            let media: { blob: Blob; name: string };
            try {
                media = await getAlignmentMediaSource();
            } catch {
                updateAiAlignmentSessionState(() => null);
                toastPubSub.pub({ type: "warning", text: lang.editor.aiNoMedia });
                return;
            }

            try {
                const result = await runLocalAiAlignment({
                    audio: media.blob,
                    audioName: media.name,
                    transcript,
                    precision: prefState.fixed === 2 ? 2 : 3,
                    keepTaskCache: prefState.keepAiTaskCache,
                    useGpuAcceleration: prefState.aiGpuAcceleration,
                    signal,
                    onProgress: (progress) =>
                        updateAiAlignmentSessionState((state) => ({
                            ...progress,
                            visible: state?.visible ?? true,
                        })),
                });
                const lyric = validateAlignedLyrics(transcript, result.lrc, trimOptions);
                lrcDispatch({ type: LrcActionType.replaceLyrics, payload: lyric });
                updateAiAlignmentSessionState(() => ({ phase: "complete", progress: 1, visible: true }));
                toastPubSub.pub({ type: "success", text: lang.editor.aiComplete });
                if (result.cacheCleanup === "failed") {
                    toastPubSub.pub({ type: "warning", text: lang.editor.aiCacheCleanupFailed });
                }
            } catch (error) {
                if (error instanceof LocalAiAlignmentError && error.code === "cancelled") {
                    updateAiAlignmentSessionState((state) => ({
                        phase: "stopped",
                        progress: state?.progress || 0,
                        visible: true,
                    }));
                    toastPubSub.pub({ type: "info", text: lang.editor.aiStopped });
                    return;
                }
                const message = alignmentErrorText(error);
                const showInstall = error instanceof LocalAiAlignmentError
                    && ["missing", "outdated", "not-running"].includes(error.code);
                updateAiAlignmentSessionState((state) => ({
                    phase: state?.phase || "connecting",
                    progress: state?.progress || 0,
                    visible: true,
                    error: message,
                    showInstall,
                }));
                toastPubSub.pub({ type: "warning", text: message });
            }
        });
        if (!started) {
            updateAiAlignmentSessionState((state) => state ? { ...state, visible: true } : state);
            toastPubSub.pub({ type: "info", text: lang.editor.aiDuplicate });
        }
    }, [
        aiSession.active,
        alignmentErrorText,
        lang.editor,
        lrcDispatch,
        prefState.aiGpuAcceleration,
        prefState.fixed,
        prefState.keepAiTaskCache,
        text,
        trimOptions,
    ]);

    const onAiAlignClick = useCallback(() => {
        if (!prefState.aiAlignmentEnabled) {
            prefDispatch({ type: "aiAlignmentEnabled", payload: true });
        }
        onAiAlign();
    }, [onAiAlign, prefDispatch, prefState.aiAlignmentEnabled]);

    const aiStatus = aiState && !aiState.error ? statusText(aiState) : aiState?.error;
    const aiEngineDownload = useMemo(
        () => aiEngineDownloadUrl(BRAND.extensionRelease, import.meta.env.app!.version, navigator.platform),
        [],
    );
    const aiRemaining = aiState?.phase === "running" && aiState.remainingSeconds
        ? lang.editor.aiRemaining.replace("%s", formatRemainingTime(aiState.remainingSeconds))
        : undefined;
    const canStopAi = aiSession.active && aiState !== null
        && ["connecting", "uploading", "queued", "running"].includes(aiState.phase);

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
                                    updateAiAlignmentSessionState((state) =>
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
                        {aiRemaining && <p className="ai-align-remaining">{aiRemaining}</p>}
                        {canStopAi && (
                            <button type="button" className="ai-align-stop" onClick={stopAiAlignmentSession}>
                                {lang.editor.aiStop}
                            </button>
                        )}
                        {aiState.showInstall && (
                            <a
                                href={aiEngineDownload}
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

const formatRemainingTime = (seconds: number): string => {
    const rounded = Math.max(1, Math.round(seconds));
    const hours = Math.floor(rounded / 3600);
    const minutes = Math.floor(rounded % 3600 / 60);
    const remainder = rounded % 60;
    return hours > 0
        ? `${hours}:${minutes.toString().padStart(2, "0")}:${remainder.toString().padStart(2, "0")}`
        : `${minutes}:${remainder.toString().padStart(2, "0")}`;
};
