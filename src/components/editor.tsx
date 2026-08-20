import BRAND from "#const/brand.json" assert { type: "json" };
import ROUTER from "#const/router.json" assert { type: "json" };
import SSK from "#const/session_key.json" assert { type: "json" };
import { parser, type State as LrcState, stringify } from "@lrc-maker/lrc-parser";
import { useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { type AdvancedLyricsAction, type AdvancedLyricsState } from "../hooks/useAdvancedLyrics.js";
import type { Action as LrcAction } from "../hooks/useLrc.js";
import { ActionType as LrcActionType } from "../hooks/useLrc.js";
import {
    createLineTimedDocument,
    exportLineLyrics,
    type ExportLyricFormat,
    type LyricsWorkspaceMode,
    serializeLyrics,
} from "../utils/advanced-lyrics.js";
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
import { AdvancedLyricsEditor } from "./advanced-lyrics-editor.js";
import { appContext } from "./app.context.js";
import { LyricsModeSwitch } from "./lyrics-mode-switch.js";
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
    advancedState: AdvancedLyricsState;
    advancedDispatch: (action: AdvancedLyricsAction) => void;
    timingMode: LyricsWorkspaceMode;
    onTimingModeChange: (mode: LyricsWorkspaceMode) => void;
    onImportFile: (file: File) => Promise<void>;
    onBasicTextParsed: (text: string) => void;
    onMetadataChanged: (name: string, value: string) => void;
    onBasicLyricsReplaced: (lyrics: LrcState["lyric"]) => void;
    wordTimingOffer: boolean;
    onAcceptWordTiming: () => void;
    onDismissWordTiming: () => void;
}> = ({
    lrcState,
    lrcDispatch,
    advancedState,
    advancedDispatch,
    timingMode,
    onTimingModeChange,
    onImportFile,
    onBasicTextParsed,
    onMetadataChanged,
    onBasicLyricsReplaced,
    wordTimingOffer,
    onAcceptWordTiming,
    onDismissWordTiming,
}) => {
    const { prefState, prefDispatch, lang, trimOptions } = useContext(appContext);

    const parse = useCallback(
        (ev: React.FocusEvent<HTMLTextAreaElement>) => {
            lrcDispatch({
                type: LrcActionType.parse,
                payload: { text: ev.target.value, options: trimOptions },
            });
            onBasicTextParsed(ev.target.value);
        },
        [lrcDispatch, onBasicTextParsed, trimOptions],
    );

    const setInfo = useCallback(
        (ev: React.FocusEvent<HTMLInputElement>) => {
            const { name, value } = ev.target;
            lrcDispatch({
                type: LrcActionType.info,
                payload: { name, value },
            });
            onMetadataChanged(name, value);
        },
        [lrcDispatch, onMetadataChanged],
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
    const textareaDefaultValue = useDefaultValue(text, textarea);
    const [exportFormat, setExportFormat] = useState<ExportLyricFormat>("lrc");
    const aiSession = useSyncExternalStore(
        subscribeAiAlignmentSession,
        getAiAlignmentSessionSnapshot,
        getAiAlignmentSessionSnapshot,
    );
    const aiState = aiSession.state;

    const exportPayload = useCallback((): string | Uint8Array => {
        const source = textarea.current?.value ?? text;
        const parsed = parser(source, trimOptions);
        const document = timingMode === "word" && advancedState.document
            ? advancedState.document
            : createLineTimedDocument(parsed.lyric, parsed.info);
        if (exportFormat === "srt" || (exportFormat === "ttml" && timingMode === "line")) {
            return exportLineLyrics(document, exportFormat, prefState.fixed);
        }
        if (exportFormat === "txt") return exportLineLyrics(document, "txt", prefState.fixed);
        return serializeLyrics(document, exportFormat, prefState.fixed);
    }, [advancedState.document, exportFormat, prefState.fixed, text, timingMode, trimOptions]);

    const exportExtension = {
        lrc: ".lrc",
        "enhanced-lrc": ".lrc",
        krc: ".krc",
        ttml: ".ttml",
        srt: ".srt",
        "ass-kf": ".ass",
        txt: ".txt",
    }[exportFormat];

    useEffect(() => {
        if (timingMode === "line" && !["lrc", "srt", "ttml", "txt"].includes(exportFormat)) {
            setExportFormat("lrc");
        }
    }, [exportFormat, timingMode]);

    const onDownloadClick = useCallback((event: React.MouseEvent<HTMLAnchorElement>) => {
        event.preventDefault();
        let payload: string | Uint8Array;
        try {
            payload = exportPayload();
        } catch {
            toastPubSub.pub({ type: "warning", text: lang.advancedLyrics.exportUnavailable });
            return;
        }
        const blobPart: BlobPart = typeof payload === "string"
            ? payload
            : new Uint8Array(payload).buffer as ArrayBuffer;
        const blob = new Blob([blobPart], {
            type: exportFormat === "krc" && timingMode === "word"
                ? "application/octet-stream"
                : exportFormat === "ass-kf"
                ? "text/x-ssa;charset=UTF-8"
                : "text/plain;charset=UTF-8",
        });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = lrcFileName(lrcState.info, exportExtension);
        link.hidden = true;
        document.body.append(link);
        link.click();
        setTimeout(() => {
            link.remove();
            URL.revokeObjectURL(url);
        }, 1000);
    }, [
        exportExtension,
        exportFormat,
        exportPayload,
        lang.advancedLyrics.exportUnavailable,
        lrcState.info,
        timingMode,
    ]);

    const onTextFileUpload = useCallback(
        (ev: React.ChangeEvent<HTMLInputElement>) => {
            if (ev.target.files === null || ev.target.files.length === 0) {
                return;
            }

            void onImportFile(ev.target.files[0]);
            ev.target.value = "";
        },
        [onImportFile],
    );

    const onCopyClick = useCallback(() => {
        let payload: string | Uint8Array;
        try {
            payload = exportPayload();
        } catch {
            toastPubSub.pub({ type: "warning", text: lang.advancedLyrics.exportUnavailable });
            return;
        }
        if (payload instanceof Uint8Array) {
            toastPubSub.pub({ type: "warning", text: lang.advancedLyrics.krcCopyUnavailable });
            return;
        }
        void navigator.clipboard.writeText(payload).then(() => {
            toastPubSub.pub({ type: "success", text: lang.advancedLyrics.copyComplete });
        });
    }, [exportPayload, lang.advancedLyrics]);

    const downloadName = useMemo(
        () => lrcFileName(lrcState.info, exportExtension),
        [exportExtension, lrcState.info],
    );

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
                onBasicLyricsReplaced(lyric);
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
        onBasicLyricsReplaced,
        prefState,
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

                {prefState.advancedLyricsEnabled && (
                    <LyricsModeSwitch
                        className="editor-mode-switch"
                        mode={timingMode}
                        onChange={onTimingModeChange}
                        labels={lang.advancedLyrics}
                    />
                )}

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
                        <input
                            hidden={true}
                            type="file"
                            accept="text/*,.txt,.lrc,.krc,.ttml,.srt,application/xml,application/octet-stream"
                            onChange={onTextFileUpload}
                        />
                        <OpenFileSVG />
                    </label>
                    <button
                        className="editor-tools-item ripple"
                        title={lang.advancedLyrics.copyExport}
                        aria-label={lang.advancedLyrics.copyExport}
                        onClick={onCopyClick}
                    >
                        <CopySVG />
                    </button>
                    <a
                        className="editor-tools-item ripple"
                        title={lang.advancedLyrics.downloadExport}
                        aria-label={lang.advancedLyrics.downloadExport}
                        href="#"
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

            <label className="advanced-editor-subbar">
                <span>{lang.advancedLyrics.exportFormat}</span>
                <select
                    className="advanced-export-select"
                    value={exportFormat}
                    onChange={(event) => setExportFormat(event.target.value as ExportLyricFormat)}
                >
                    <option value="lrc">{lang.advancedLyrics.standardLrcDefault}</option>
                    {timingMode === "word" && (
                        <>
                            <option value="enhanced-lrc">{lang.advancedLyrics.enhancedLrc}</option>
                            <option value="krc">KRC</option>
                            <option value="ttml">{lang.advancedLyrics.wordTtml}</option>
                            <option value="ass-kf">{lang.advancedLyrics.assKf}</option>
                        </>
                    )}
                    <option value="srt">{lang.advancedLyrics.lineSrt}</option>
                    {timingMode === "line" && (
                        <>
                            <option value="ttml">{lang.advancedLyrics.lineTtml}</option>
                            <option value="txt">{lang.advancedLyrics.plainText}</option>
                        </>
                    )}
                </select>
                {timingMode === "word" && ["lrc", "srt"].includes(exportFormat) && (
                    <strong>{lang.advancedLyrics.lineOnlyExport}</strong>
                )}
                {timingMode === "word" && (
                    <a className="word-timing-link" href={prependHash(ROUTER.wordSynchronizer)}>
                        {lang.advancedLyrics.openWordTiming}
                    </a>
                )}
            </label>
            {timingMode === "word" && advancedState.document
                ? (
                    <>
                        <AdvancedLyricsEditor
                            state={advancedState}
                            dispatch={advancedDispatch}
                            fixed={prefState.fixed}
                            language={lang.advancedLyrics}
                        />
                    </>
                )
                : (
                    <textarea
                        className="app-textarea"
                        aria-label="lrc input here"
                        onBlur={parse}
                        {...disableCheck}
                        {...textareaDefaultValue}
                    />
                )}
            {wordTimingOffer && (
                <dialog className="word-timing-offer" open={true} aria-labelledby="word-timing-offer-title">
                    <article>
                        <h2 id="word-timing-offer-title">{lang.advancedLyrics.wordDetectedTitle}</h2>
                        <p>{lang.advancedLyrics.wordDetectedMessage}</p>
                        <footer>
                            <button type="button" onClick={onDismissWordTiming}>
                                {lang.advancedLyrics.keepLineMode}
                            </button>
                            <button type="button" onClick={onAcceptWordTiming}>
                                {lang.advancedLyrics.switchWordMode}
                            </button>
                        </footer>
                    </article>
                </dialog>
            )}
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
