import BRAND from "#const/brand.json" assert { type: "json" };
import ROUTER from "#const/router.json" assert { type: "json" };
import SSK from "#const/session_key.json" assert { type: "json" };
import { parser, type State as LrcState } from "@lrc-maker/lrc-parser";
import { useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AdvancedActionType, type AdvancedLyricsAction, type AdvancedLyricsState } from "../hooks/useAdvancedLyrics.js";
import type { Action as LrcAction } from "../hooks/useLrc.js";
import { ActionType as LrcActionType } from "../hooks/useLrc.js";
import {
    createLineTimedDocument,
    exportLineLyrics,
    type ExportLyricFormat,
    type LyricsWorkspaceMode,
    serializeLyrics,
    toEnhancedLrc,
} from "../utils/advanced-lyrics.js";
import { createUntimedTranscript, validateAlignedLyrics } from "../utils/ai-alignment-result.js";
import {
    type AiAlignmentSessionState,
    getAiAlignmentSessionSnapshot,
    startAiAlignmentSession,
    stopAiAlignmentSession,
    subscribeAiAlignmentSession,
    updateAiAlignmentSessionState,
} from "../utils/ai-alignment-session.js";
import { aiEngineDownloadUrl } from "../utils/ai-engine-download.js";
import { getStoredApiKeySummary, subscribeApiKeyVault } from "../utils/ai-key-vault.js";
import { getAlignmentMediaInfo, getAlignmentMediaSource } from "../utils/alignment-media.js";
import { audioRef } from "../utils/audiomodule.js";
import { CloudAiAlignmentError, type CloudAiTaskMode, runCloudAiAlignment } from "../utils/cloud-ai-alignment.js";
import {
    LocalAiAlignmentError,
    type LocalAlignmentProgress,
    runLocalAiAlignment,
} from "../utils/local-ai-alignment.js";
import { lrcFileName } from "../utils/lrc-file-name.js";
import { stringifyLrc } from "../utils/lrc-format.js";
import { prependHash } from "../utils/router.js";
import { parseWordEditorSource } from "../utils/word-source.js";
import { appContext } from "./app.context.js";
import { loadAudioDialogRef } from "./loadaudio.js";
import { LyricTextEditor } from "./lyric-text-editor.js";
import { LyricsModeSwitch } from "./lyrics-mode-switch.js";
import { StyledSelect } from "./styled-select.js";
import { AiAlignSVG, CopySVG, DownloadSVG, OpenFileSVG, SynchronizerSVG, UtilitySVG } from "./svg.js";
import { toastPubSub } from "./toast.js";
import "./editor.css";
import "./advanced-lyrics.css";

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
    onDraftChange?: (text: string | null) => void;
    onMetadataChanged: (name: string, value: string) => void;
    onBasicLyricsReplaced: (lyrics: LrcState["lyric"]) => void;
    onWordAlignmentApplied?: (document: NonNullable<AdvancedLyricsState["document"]>) => void;
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
    onDraftChange,
    onMetadataChanged,
    onBasicLyricsReplaced,
    onWordAlignmentApplied,
    wordTimingOffer,
    onAcceptWordTiming,
    onDismissWordTiming,
}) => {
    const { prefState, prefDispatch, lang, trimOptions } = useContext(appContext);
    const editedWordSource = useRef<
        {
            document: AdvancedLyricsState["document"];
            source: string;
            fixed: Fixed;
        } | null
    >(null);
    const text = useMemo(
        () =>
            timingMode === "word" && advancedState.document
                ? editedWordSource.current?.document === advancedState.document
                        && editedWordSource.current.fixed === prefState.fixed
                    ? editedWordSource.current.source
                    : toEnhancedLrc(advancedState.document, prefState.fixed)
                : stringifyLrc(lrcState, prefState),
        [advancedState.document, lrcState, prefState, timingMode],
    );

    const commitText = useCallback(
        (rawText: string) => {
            if (timingMode === "word") {
                if (rawText.replace(/\r\n?/g, "\n") === text.replace(/\r\n?/g, "\n")) return;
                const document = parseWordEditorSource(rawText);
                editedWordSource.current = { document, source: rawText, fixed: prefState.fixed };
                advancedDispatch({ type: AdvancedActionType.editDocument, payload: document });
                return;
            }
            lrcDispatch({
                type: LrcActionType.parse,
                payload: { text: rawText, options: trimOptions },
            });
            onBasicTextParsed(rawText);
        },
        [
            advancedDispatch,
            advancedState.document,
            lrcDispatch,
            onBasicTextParsed,
            prefState.fixed,
            timingMode,
            text,
            trimOptions,
        ],
    );

    const parse = useCallback(
        (ev: React.FocusEvent<HTMLTextAreaElement>) => {
            commitText(ev.target.value);
        },
        [commitText],
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

    const [detailsOpened, setDetailsOpened] = useState(() => sessionStorage.getItem(SSK.editorDetailsOpen) === "true");

    const toggleDetails = useCallback(() => {
        setDetailsOpened((prev) => {
            const next = !prev;
            sessionStorage.setItem(SSK.editorDetailsOpen, next.toString());
            return next;
        });
    }, []);

    const tiInputProps = useDefaultValue(lrcState.info.get("ti") || "");
    const arInputProps = useDefaultValue(lrcState.info.get("ar") || "");
    const alInputProps = useDefaultValue(lrcState.info.get("al") || "");

    const metaSummary = useMemo(() => {
        const parts = [lrcState.info.get("ti")?.trim(), lrcState.info.get("ar")?.trim()].filter(Boolean);
        return parts.join(" — ");
    }, [lrcState.info]);

    const timedLineCount = useMemo(
        () => lrcState.lyric.reduce((count, line) => count + (line.time !== undefined ? 1 : 0), 0),
        [lrcState.lyric],
    );

    const textarea = useRef<HTMLInputLikeElement>(null);
    const lyricFileInput = useRef<HTMLInputElement>(null);
    const wordTimingDialog = useRef<HTMLDialogElement>(null);
    const [exportFormat, setExportFormat] = useState<ExportLyricFormat>(() =>
        timingMode === "word" ? prefState.defaultWordExportFormat : prefState.defaultLineExportFormat
    );
    useEffect(() => {
        setExportFormat(
            timingMode === "word" ? prefState.defaultWordExportFormat : prefState.defaultLineExportFormat,
        );
    }, [prefState.defaultLineExportFormat, prefState.defaultWordExportFormat, timingMode]);
    useEffect(() => {
        const dialog = wordTimingDialog.current;
        if (wordTimingOffer && dialog && !dialog.open) dialog.showModal();
    }, [wordTimingOffer]);
    const keyVaultSummary = useSyncExternalStore(
        subscribeApiKeyVault,
        getStoredApiKeySummary,
        getStoredApiKeySummary,
    );
    const [aiLaunchOpen, setAiLaunchOpen] = useState(false);
    const [cloudTaskMode, setCloudTaskMode] = useState<CloudAiTaskMode>("line");
    const aiLaunchDialog = useRef<HTMLDialogElement>(null);

    const closeAiLaunch = useCallback(() => {
        if (aiLaunchDialog.current?.open) aiLaunchDialog.current.close();
        setAiLaunchOpen(false);
    }, []);

    useEffect(() => {
        const dialog = aiLaunchDialog.current;
        if (!dialog) return;
        if (aiLaunchOpen && !dialog.open) dialog.showModal();
        else if (!aiLaunchOpen && dialog.open) dialog.close();
    }, [aiLaunchOpen]);

    const exportPayload = useCallback((): string | Uint8Array => {
        const source = textarea.current?.value ?? text;
        if (timingMode === "word" && exportFormat === "enhanced-lrc") return source;
        const parsed = parser(source, trimOptions);
        const document = timingMode === "word"
            ? parseWordEditorSource(source)
            : createLineTimedDocument(parsed.lyric, parsed.info);
        if (exportFormat === "srt" || (exportFormat === "ttml" && timingMode === "line")) {
            return exportLineLyrics(document, exportFormat, prefState.fixed);
        }
        if (exportFormat === "txt") return exportLineLyrics(document, "txt", prefState.fixed);
        return serializeLyrics(document, exportFormat, prefState.fixed);
    }, [exportFormat, prefState.fixed, text, timingMode, trimOptions]);

    const exportExtension = {
        lrc: ".lrc",
        "enhanced-lrc": ".lrc",
        krc: ".krc",
        ttml: ".ttml",
        srt: ".srt",
        "ass-kf": ".ass",
        txt: ".txt",
    }[exportFormat];

    useEffect(() => setExportFormat(timingMode === "word" ? "enhanced-lrc" : "lrc"), [timingMode]);

    const onDownloadClick = useCallback(() => {
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
        const copyFallback = (value: string): boolean => {
            const helper = document.createElement("textarea");
            helper.value = value;
            helper.setAttribute("readonly", "");
            helper.style.position = "fixed";
            helper.style.opacity = "0";
            document.body.append(helper);
            helper.select();
            const ok = document.execCommand("copy");
            helper.remove();
            return ok;
        };
        void navigator.clipboard.writeText(payload).then(() => {
            toastPubSub.pub({ type: "success", text: lang.advancedLyrics.copyComplete });
        }).catch(() => {
            if (copyFallback(payload)) {
                toastPubSub.pub({ type: "success", text: lang.advancedLyrics.copyComplete });
            } else {
                toastPubSub.pub({ type: "warning", text: lang.advancedLyrics.exportUnavailable });
            }
        });
    }, [exportPayload, lang.advancedLyrics]);

    const alignmentErrorText = useCallback((error: unknown): string => {
        if (error instanceof CloudAiAlignmentError) {
            switch (error.code) {
                case "missing-key":
                    return lang.editor.aiCloudMissingKey;
                case "invalid-key":
                    return lang.editor.aiCloudInvalidKey;
                case "rate-limited":
                    return lang.editor.aiCloudRateLimited;
                case "quota-exceeded":
                    return lang.editor.aiCloudQuotaExceeded;
                case "media-too-large":
                    return lang.editor.aiCloudMediaTooLarge;
                case "upload-failed":
                    return lang.editor.aiCloudUploadFailed;
                case "network":
                    return lang.editor.aiCloudNetworkError;
                case "line-count-mismatch":
                    return error.detail
                        ? lang.editor.aiCloudLineMismatch.replace("%s", error.detail)
                        : lang.editor.aiCloudInvalidOutput;
                case "truncated":
                    return lang.editor.aiCloudTruncated;
                case "invalid-output":
                    return lang.editor.aiCloudInvalidOutput;
                default:
                    return lang.editor.aiCloudFailed;
            }
        }
        if (error instanceof LocalAiAlignmentError) {
            if (error.code === "missing") return lang.editor.aiExtensionMissing;
            if (error.code === "outdated") return lang.editor.aiExtensionOutdated;
            if (error.code === "mobile") return lang.editor.aiMobileDesktopRequired;
            if (error.code === "not-running") return lang.editor.aiServiceMissing;
            if (error.code === "busy") return lang.editor.aiDuplicate;
        }
        return lang.editor.aiFailed;
    }, [lang.editor]);

    const onCloudAiAlign = useCallback((selectedMode: CloudAiTaskMode) => {
        closeAiLaunch();
        if (getAiAlignmentSessionSnapshot().active) {
            updateAiAlignmentSessionState((state) => state ? { ...state, visible: true } : state);
            toastPubSub.pub({ type: "info", text: lang.editor.aiDuplicate });
            return;
        }
        const provider = prefState.aiCloudProvider;
        const model = provider === "gemini" ? prefState.aiGeminiModel : prefState.aiOpenRouterModel;

        const started = startAiAlignmentSession(async (signal): Promise<void> => {
            const currentText = textarea.current ? textarea.current.value : text;
            const transcript = createUntimedTranscript(currentText, trimOptions);
            const hasLyrics = transcript.split(/\r\n|\n|\r/).some((line) => line.trim());
            if (selectedMode !== "transcribe" && !hasLyrics) {
                toastPubSub.pub({ type: "warning", text: lang.editor.aiNoLyrics });
                return;
            }

            updateAiAlignmentSessionState(() => ({
                phase: "connecting",
                progress: 0.02,
                provider,
                taskMode: selectedMode,
                visible: true,
            }));

            let media: { blob: Blob; name: string };
            try {
                media = await getAlignmentMediaSource();
            } catch {
                updateAiAlignmentSessionState(() => null);
                toastPubSub.pub({ type: "warning", text: lang.editor.aiNoMedia });
                return;
            }

            try {
                const audioDurationMs = audioRef.duration > 0 ? Math.round(audioRef.duration * 1000) : undefined;
                const result = await runCloudAiAlignment({
                    provider,
                    model,
                    audio: media.blob,
                    audioName: media.name,
                    audioDurationMs,
                    transcript: selectedMode === "transcribe" ? "" : transcript,
                    mode: selectedMode,
                    precision: prefState.fixed === 2 ? 2 : 3,
                    thinking: prefState.aiCloudThinking,
                    customLinePrompt: prefState.aiLinePrompt,
                    customWordPrompt: prefState.aiWordPrompt,
                    metadata: lrcState.info,
                    trimOptions,
                    signal,
                    onProgress: (progress) =>
                        updateAiAlignmentSessionState((state) => ({
                            ...progress,
                            provider,
                            taskMode: selectedMode,
                            visible: state?.visible ?? true,
                        })),
                });

                if (result.mode === "word-beta" && result.advancedDocument) {
                    editedWordSource.current = null;
                    if (onWordAlignmentApplied) {
                        onWordAlignmentApplied(result.advancedDocument);
                    } else {
                        if (!prefState.advancedLyricsEnabled) {
                            prefDispatch({ type: "advancedLyricsEnabled", payload: true });
                        }
                        lrcDispatch({ type: LrcActionType.replaceLyrics, payload: result.lyrics });
                        advancedDispatch({ type: AdvancedActionType.load, payload: result.advancedDocument });
                        onTimingModeChange("word");
                    }
                } else {
                    lrcDispatch({ type: LrcActionType.replaceLyrics, payload: result.lyrics });
                    onBasicLyricsReplaced(result.lyrics);
                }

                updateAiAlignmentSessionState(() => ({
                    phase: "complete",
                    progress: 1,
                    provider,
                    taskMode: selectedMode,
                    visible: false,
                }));
                toastPubSub.pub({
                    type: "success",
                    text: result.mode === "word-beta" ? lang.editor.aiWordBetaComplete : lang.editor.aiComplete,
                });
            } catch (error) {
                if (error instanceof CloudAiAlignmentError && error.code === "cancelled") {
                    updateAiAlignmentSessionState((state) => ({
                        phase: "stopped",
                        progress: state?.progress || 0,
                        provider,
                        taskMode: selectedMode,
                        visible: false,
                    }));
                    toastPubSub.pub({ type: "info", text: lang.editor.aiStopped });
                    return;
                }
                const message = alignmentErrorText(error);
                const showSettings = error instanceof CloudAiAlignmentError
                    && (error.code === "missing-key" || error.code === "invalid-key");
                updateAiAlignmentSessionState((state) => ({
                    phase: state?.phase || "connecting",
                    progress: state?.progress || 0,
                    provider,
                    taskMode: selectedMode,
                    visible: true,
                    error: message,
                    showSettings,
                }));
                toastPubSub.pub({ type: "warning", text: message });
            }
        });

        if (!started) {
            updateAiAlignmentSessionState((state) => state ? { ...state, visible: true } : state);
            toastPubSub.pub({ type: "info", text: lang.editor.aiDuplicate });
        }
    }, [
        advancedDispatch,
        alignmentErrorText,
        closeAiLaunch,
        lang.editor,
        lrcDispatch,
        lrcState.info,
        onBasicLyricsReplaced,
        onTimingModeChange,
        onWordAlignmentApplied,
        prefDispatch,
        prefState.advancedLyricsEnabled,
        prefState.aiCloudProvider,
        prefState.aiCloudThinking,
        prefState.aiGeminiModel,
        prefState.aiLinePrompt,
        prefState.aiOpenRouterModel,
        prefState.aiWordPrompt,
        prefState.fixed,
        text,
        trimOptions,
    ]);

    const onAiAlign = useCallback(() => {
        if (getAiAlignmentSessionSnapshot().active) {
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
            updateAiAlignmentSessionState(() => ({ ...initial, provider: "local", visible: true }));
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
                            provider: state?.provider || "local",
                            visible: state?.visible ?? true,
                        })),
                });
                const lyric = validateAlignedLyrics(transcript, result.lrc, trimOptions);
                lrcDispatch({ type: LrcActionType.replaceLyrics, payload: lyric });
                onBasicLyricsReplaced(lyric);
                updateAiAlignmentSessionState(() => ({
                    phase: "complete",
                    progress: 1,
                    provider: "local",
                    visible: false,
                }));
                toastPubSub.pub({ type: "success", text: lang.editor.aiComplete });
                if (result.cacheCleanup === "failed") {
                    toastPubSub.pub({ type: "warning", text: lang.editor.aiCacheCleanupFailed });
                }
            } catch (error) {
                if (error instanceof LocalAiAlignmentError && error.code === "cancelled") {
                    updateAiAlignmentSessionState((state) => ({
                        phase: "stopped",
                        progress: state?.progress || 0,
                        provider: "local",
                        visible: false,
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
                    provider: "local",
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
        if (prefState.aiEngine === "cloud") {
            if (getAiAlignmentSessionSnapshot().active) {
                updateAiAlignmentSessionState((state) => state ? { ...state, visible: true } : state);
                return;
            }
            const currentText = textarea.current ? textarea.current.value : text;
            const transcript = createUntimedTranscript(currentText, trimOptions);
            const hasLyrics = transcript.split(/\r\n|\n|\r/).some((line) => line.trim());
            setCloudTaskMode(
                !hasLyrics ? "transcribe" : timingMode === "word" ? "word-beta" : "line",
            );
            setAiLaunchOpen(true);
            return;
        }
        if (!prefState.aiAlignmentEnabled) {
            prefDispatch({ type: "aiAlignmentEnabled", payload: true });
        }
        onAiAlign();
    }, [
        onAiAlign,
        prefDispatch,
        prefState.aiAlignmentEnabled,
        prefState.aiEngine,
        text,
        timingMode,
        trimOptions,
    ]);

    const activeCloudProvider = prefState.aiCloudProvider;
    const activeCloudModel = activeCloudProvider === "gemini"
        ? prefState.aiGeminiModel
        : prefState.aiOpenRouterModel;
    const activeCloudKeyConfigured = keyVaultSummary[activeCloudProvider].configured;
    const launchMediaInfo = aiLaunchOpen ? getAlignmentMediaInfo() : null;
    const launchLyricStats = useMemo(() => {
        if (!aiLaunchOpen) return { total: 0, timed: 0 };
        const currentText = textarea.current ? textarea.current.value : text;
        const parsed = parser(currentText, trimOptions);
        const transcript = createUntimedTranscript(currentText, trimOptions);
        const total = transcript.split(/\r\n|\n|\r/).filter((line) => line.trim()).length;
        const timed = parsed.lyric.reduce(
            (count, line) => count + (line.time !== undefined || /<\s*\d{1,3}:\d{1,2}/.test(line.text) ? 1 : 0),
            0,
        );
        return { total, timed };
    }, [aiLaunchOpen, text, trimOptions]);
    const launchLyricLineCount = launchLyricStats.total;
    const aiButtonActive = prefState.aiEngine === "cloud"
        ? activeCloudKeyConfigured
        : prefState.aiAlignmentEnabled;

    return (
        <div className="app-editor">
            <header className="editor-commandbar ai-enabled">
                <div className="editor-topbar">
                    <button
                        type="button"
                        className="editor-meta-toggle"
                        aria-expanded={detailsOpened}
                        aria-controls="editor-meta-infobox"
                        onClick={toggleDetails}
                    >
                        <span className="editor-meta-label">{lang.editor.metaInfo}</span>
                        {!detailsOpened && metaSummary && (
                            <span className="editor-meta-summary" title={metaSummary}>
                                {metaSummary}
                            </span>
                        )}
                    </button>

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
                            type="button"
                            className={`editor-tools-item ripple ai-align-button${aiButtonActive ? "" : " is-off"}`}
                            title={prefState.aiEngine === "cloud"
                                ? lang.editor.aiAlign
                                : prefState.aiAlignmentEnabled
                                ? lang.editor.aiAlign
                                : lang.editor.aiEnableAndAlign}
                            aria-label={prefState.aiEngine === "cloud"
                                ? lang.editor.aiAlign
                                : prefState.aiAlignmentEnabled
                                ? lang.editor.aiAlign
                                : lang.editor.aiEnableAndAlign}
                            aria-pressed={aiButtonActive}
                            onClick={onAiAlignClick}
                        >
                            <AiAlignSVG />
                            <span>AI</span>
                        </button>
                        <button
                            type="button"
                            className="editor-tools-item ripple"
                            title={lang.editor.uploadText}
                            aria-label={lang.editor.uploadText}
                            onClick={() => lyricFileInput.current?.click()}
                        >
                            <OpenFileSVG />
                        </button>
                        <input
                            ref={lyricFileInput}
                            hidden={true}
                            type="file"
                            accept="text/*,.txt,.lrc,.krc,.ttml,.srt,application/xml,application/octet-stream"
                            onChange={onTextFileUpload}
                        />
                        <button
                            type="button"
                            className="editor-tools-item ripple"
                            title={lang.advancedLyrics.copyExport}
                            aria-label={lang.advancedLyrics.copyExport}
                            onClick={onCopyClick}
                        >
                            <CopySVG />
                        </button>
                        <button
                            type="button"
                            className="editor-tools-item ripple"
                            title={lang.advancedLyrics.downloadExport}
                            aria-label={lang.advancedLyrics.downloadExport}
                            onClick={onDownloadClick}
                        >
                            <DownloadSVG />
                        </button>

                        <a
                            title={lang.editor.utils}
                            aria-label={lang.editor.utils}
                            href={prependHash(ROUTER.tools)}
                            className="editor-tools-item ripple"
                        >
                            <UtilitySVG />
                        </a>
                    </section>
                </div>

                <section
                    id="editor-meta-infobox"
                    className={`app-editor-infobox${detailsOpened ? " is-open" : ""}`}
                    hidden={!detailsOpened}
                    onBlur={setInfo}
                >
                    <label htmlFor="info-ti">
                        <span>{lang.editor.title}</span>
                        <input
                            id="info-ti"
                            name="ti"
                            {...disableCheck}
                            {...tiInputProps}
                        />
                    </label>
                    <label htmlFor="info-ar">
                        <span>{lang.editor.artist}</span>
                        <input
                            id="info-ar"
                            name="ar"
                            {...disableCheck}
                            {...arInputProps}
                        />
                    </label>
                    <label htmlFor="info-al">
                        <span>{lang.editor.album}</span>
                        <input
                            id="info-al"
                            name="al"
                            {...disableCheck}
                            {...alInputProps}
                        />
                    </label>
                </section>
            </header>

            <div className="advanced-editor-subbar">
                <span className="editor-line-stats">
                    {lang.editor.lineStats
                        .replace("%total", String(lrcState.lyric.length))
                        .replace("%timed", String(timedLineCount))}
                </span>
                <div className="advanced-editor-subbar-actions">
                    <span>{lang.advancedLyrics.exportFormat}</span>
                    <StyledSelect
                        className="advanced-export-select"
                        value={exportFormat}
                        onValueChange={(value) => setExportFormat(value as ExportLyricFormat)}
                        label={lang.advancedLyrics.exportFormat}
                        options={[
                            {
                                value: "lrc",
                                label: timingMode === "word"
                                    ? lang.advancedLyrics.standardLrc
                                    : lang.advancedLyrics.standardLrcDefault,
                            },
                            ...(timingMode === "word"
                                ? [
                                    { value: "enhanced-lrc", label: lang.advancedLyrics.enhancedLrcDefault },
                                    { value: "krc", label: "KRC" },
                                    { value: "ttml", label: lang.advancedLyrics.wordTtml },
                                    { value: "ass-kf", label: lang.advancedLyrics.assKf },
                                ]
                                : []),
                            { value: "srt", label: lang.advancedLyrics.lineSrt },
                            ...(timingMode === "line"
                                ? [
                                    { value: "ttml", label: lang.advancedLyrics.lineTtml },
                                    { value: "txt", label: lang.advancedLyrics.plainText },
                                ]
                                : []),
                        ]}
                    />
                    {timingMode === "word" && ["lrc", "srt"].includes(exportFormat) && (
                        <strong>{lang.advancedLyrics.lineOnlyExport}</strong>
                    )}
                    {timingMode === "line" && lrcState.lyric.length > 0 && (
                        <a className="word-timing-link" href={prependHash(ROUTER.synchronizer)}>
                            <SynchronizerSVG />
                            <span>{lang.editor.openLineTiming}</span>
                        </a>
                    )}
                    {timingMode === "word" && (
                        <a className="word-timing-link" href={prependHash(ROUTER.wordSynchronizer)}>
                            <span>{lang.advancedLyrics.openWordTiming}</span>
                        </a>
                    )}
                </div>
            </div>
            <LyricTextEditor
                text={text}
                inputRef={textarea}
                onBlur={parse}
                onCommitText={commitText}
                onDraftChange={onDraftChange}
                wordTiming={timingMode === "word"}
                language={lang}
            />
            {wordTimingOffer && (
                <dialog
                    ref={wordTimingDialog}
                    className="word-timing-offer"
                    aria-labelledby="word-timing-offer-title"
                    onCancel={(event) => {
                        event.preventDefault();
                        onDismissWordTiming();
                    }}
                    onClose={onDismissWordTiming}
                >
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
            {aiLaunchOpen && (
                <dialog
                    ref={aiLaunchDialog}
                    className="ai-launch-dialog"
                    aria-labelledby="ai-launch-title"
                    onCancel={(event) => {
                        event.preventDefault();
                        setAiLaunchOpen(false);
                    }}
                    onClose={() => setAiLaunchOpen(false)}
                >
                    <article>
                        <header className="ai-launch-header">
                            <div>
                                <h2 id="ai-launch-title">{lang.editor.aiCloudTitle}</h2>
                                <p className="ai-launch-meta">
                                    {activeCloudProvider === "gemini"
                                        ? lang.preferences.aiProviderGemini
                                        : lang.preferences.aiProviderOpenRouter}
                                    {" · "}
                                    <code>{activeCloudModel}</code>
                                </p>
                            </div>
                            <a
                                className="ai-launch-settings-link"
                                href={prependHash(ROUTER.preferences)}
                                onClick={closeAiLaunch}
                            >
                                {lang.editor.aiOpenSettings}
                            </a>
                        </header>

                        <div className="ai-launch-summary">
                            <div className={`ai-launch-chip${launchMediaInfo ? " is-ready" : " is-missing"}`}>
                                <span>{lang.editor.aiSourceAudio}</span>
                                <strong>
                                    {launchMediaInfo
                                        ? `${launchMediaInfo.name}${
                                            launchMediaInfo.size
                                                ? ` (${formatFileSize(launchMediaInfo.size)})`
                                                : ""
                                        }`
                                        : lang.editor.aiNoMediaShort}
                                </strong>
                                {!launchMediaInfo && (
                                    <button
                                        type="button"
                                        className="ai-launch-inline-action"
                                        onClick={() => {
                                            closeAiLaunch();
                                            loadAudioDialogRef.open();
                                        }}
                                    >
                                        {lang.audio.loadAudio}
                                    </button>
                                )}
                            </div>
                            <div className={`ai-launch-chip${launchLyricLineCount > 0 ? " is-ready" : ""}`}>
                                <span>{lang.editor.aiSourceText}</span>
                                <strong>
                                    {launchLyricLineCount > 0
                                        ? lang.editor.aiSourceLines.replace("%d", String(launchLyricLineCount))
                                        : lang.editor.aiSourceTextEmpty}
                                </strong>
                                {launchLyricStats.timed > 0 && cloudTaskMode !== "transcribe" && (
                                    <small className="ai-launch-strip-note">
                                        {lang.editor.aiStripExistingTiming.replace(
                                            "%d",
                                            String(launchLyricStats.timed),
                                        )}
                                    </small>
                                )}
                            </div>
                        </div>

                        <fieldset className="ai-launch-modes">
                            <legend>{lang.editor.aiTaskMode}</legend>
                            <label className={cloudTaskMode === "line" ? "is-selected" : undefined}>
                                <input
                                    type="radio"
                                    name="cloud-ai-mode"
                                    value="line"
                                    checked={cloudTaskMode === "line"}
                                    onChange={() => setCloudTaskMode("line")}
                                />
                                <div>
                                    <strong>{lang.editor.aiModeLine}</strong>
                                    <span>{lang.editor.aiModeLineDesc}</span>
                                </div>
                            </label>
                            <label className={cloudTaskMode === "transcribe" ? "is-selected" : undefined}>
                                <input
                                    type="radio"
                                    name="cloud-ai-mode"
                                    value="transcribe"
                                    checked={cloudTaskMode === "transcribe"}
                                    onChange={() => setCloudTaskMode("transcribe")}
                                />
                                <div>
                                    <strong>{lang.editor.aiModeTranscribe}</strong>
                                    <span>{lang.editor.aiModeTranscribeDesc}</span>
                                </div>
                            </label>
                            <label className={cloudTaskMode === "word-beta" ? "is-selected" : undefined}>
                                <input
                                    type="radio"
                                    name="cloud-ai-mode"
                                    value="word-beta"
                                    checked={cloudTaskMode === "word-beta"}
                                    onChange={() => setCloudTaskMode("word-beta")}
                                />
                                <div>
                                    <strong>
                                        {lang.editor.aiModeWordBeta}
                                        <em className="ai-beta-badge">Beta</em>
                                    </strong>
                                    <span>{lang.editor.aiModeWordBetaDesc}</span>
                                </div>
                            </label>
                        </fieldset>

                        {!activeCloudKeyConfigured && (
                            <p className="ai-launch-warning" role="alert">
                                {lang.editor.aiCloudMissingKey}
                            </p>
                        )}

                        <footer className="ai-launch-footer">
                            <button type="button" onClick={closeAiLaunch}>
                                {lang.editor.aiClose}
                            </button>
                            <button
                                type="button"
                                className="is-primary"
                                disabled={!activeCloudKeyConfigured || !launchMediaInfo
                                    || (cloudTaskMode !== "transcribe" && launchLyricLineCount === 0)}
                                onClick={() => onCloudAiAlign(cloudTaskMode)}
                            >
                                {lang.editor.aiStartAction}
                            </button>
                        </footer>
                    </article>
                </dialog>
            )}
            <AiAlignmentStatusDialog lang={lang} />
        </div>
    );
};

const AiAlignmentStatusDialog: React.FC<{ lang: Language }> = ({ lang }) => {
    const aiSession = useSyncExternalStore(
        subscribeAiAlignmentSession,
        getAiAlignmentSessionSnapshot,
        getAiAlignmentSessionSnapshot,
    );
    const aiState = aiSession.state;
    const aiEngineDownload = useMemo(
        () => aiEngineDownloadUrl(BRAND.extensionRelease, import.meta.env.app!.version, navigator.platform),
        [],
    );

    if (!aiState?.visible) return null;

    const aiStatus = !aiState.error ? formatAiStatusText(aiState, lang) : aiState.error;
    const aiRemaining = aiState.phase === "running" && aiState.remainingSeconds
        ? lang.editor.aiRemaining.replace("%s", formatRemainingTime(aiState.remainingSeconds))
        : undefined;
    const canStopAi = aiSession.active
        && ["connecting", "uploading", "queued", "running", "downloading"].includes(aiState.phase);
    const aiDialogTitle = aiState.provider === "gemini" || aiState.provider === "openrouter"
        ? lang.editor.aiCloudTitle
        : lang.editor.aiTitle;

    return (
        <dialog className="ai-align-dialog" open={true} aria-labelledby="ai-align-title">
            <article>
                <header>
                    <h2 id="ai-align-title">{aiDialogTitle}</h2>
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
                {aiState.showSettings && (
                    <a
                        href={prependHash(ROUTER.preferences)}
                        onClick={() => updateAiAlignmentSessionState((state) => state && { ...state, visible: false })}
                    >
                        {lang.editor.aiOpenSettings}
                    </a>
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
    );
};

const formatAiStatusText = (progress: AiAlignmentSessionState, lang: Language): string => {
    const isCloud = progress.provider === "gemini" || progress.provider === "openrouter";
    switch (progress.phase) {
        case "connecting":
            return isCloud ? lang.editor.aiCloudConnecting : lang.editor.aiConnecting;
        case "uploading":
            return isCloud ? lang.editor.aiCloudUploading : lang.editor.aiUploading;
        case "queued":
            return lang.editor.aiQueued;
        case "running":
            if (isCloud) {
                return progress.streamChars && progress.streamChars > 0
                    ? lang.editor.aiCloudStreaming.replace("%d", String(progress.streamChars))
                    : lang.editor.aiCloudRunning;
            }
            return lang.editor.aiRunning;
        case "downloading":
            return isCloud ? lang.editor.aiCloudParsing : lang.editor.aiDownloading;
        case "stopping":
            return lang.editor.aiStopping;
        case "stopped":
            return lang.editor.aiStopped;
        case "cleaning":
            return lang.editor.aiCleaning;
        case "complete":
            return progress.taskMode === "word-beta"
                ? lang.editor.aiWordBetaComplete
                : lang.editor.aiComplete;
    }
};

const formatFileSize = (bytes: number): string => {
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
