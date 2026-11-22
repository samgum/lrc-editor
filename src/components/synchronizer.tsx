import ROUTER from "#const/router.json" assert { type: "json" };
import SSK from "#const/session_key.json" assert { type: "json" };
import STRINGS from "#const/strings.json" assert { type: "json" };
import { formatText, type ILyric } from "@lrc-maker/lrc-parser";
import { memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
    AdvancedActionType,
    type AdvancedLyricsAction,
    type AdvancedLyricsState,
    nextSyncWordCursor,
    type WordCursor,
} from "../hooks/useAdvancedLyrics.js";
import { useKeyBindings } from "../hooks/useKeyBindings.js";
import type { IState } from "../hooks/useLrc.js";
import { type Action, ActionType, guard } from "../hooks/useLrc.js";
import { type State as PrefState } from "../hooks/usePref.js";
import {
    type AdvancedLyricLine,
    isWordTimingPending,
    lineText as advancedLineText,
    type LyricsWorkspaceMode,
    type WordTimingIssue,
    wordTimingIssueAt,
} from "../utils/advanced-lyrics.js";
import { AudioActionType, audioRef, audioStatePubSub, currentTimePubSub } from "../utils/audiomodule.js";
import {
    centeredFollowOffset,
    followEndSpace,
    lookAheadFollowOffset,
    visibleFollowOffset,
} from "../utils/follow-scroll.js";
import { InputAction } from "../utils/input-action.js";
import { shouldIgnoreGlobalShortcut } from "../utils/is-keyboard-element.js";
import { formatKeyBinding, getMatchedAction } from "../utils/keybindings.js";
import { formatTimeTag } from "../utils/lrc-format.js";
import { prependHash } from "../utils/router.js";
import { timingIssueAt } from "../utils/timing-issues.js";
import { captureWaveformTime, setWaveformTimingHandler } from "../utils/waveform-timing.js";
import { buildWordPlaybackIndex, wordsAtTimeFromIndex } from "../utils/word-playback.js";
import { appContext } from "./app.context.js";
import { AsidePanel } from "./asidepanel.js";
import { Curser } from "./curser.js";
import { ProblemSVG } from "./svg.js";
import { TimingWaveformPanel } from "./timing-waveform-panel.js";
import type { WaveformHandle } from "./waveform.js";
import { WordTimingStage } from "./word-timing-stage.js";
import "./asidepanel.css";
import "./synchronizer.css";

const EMPTY_PLAYBACK_WORDS: readonly number[] = [];

const SpaceButton: React.FC<{
    sync: () => void;
    disabled: boolean;
    label: string;
    shortcutLabel: string | null;
}> = ({ sync, disabled, label, shortcutLabel }) => {
    return (
        <button
            type="button"
            className="space-button"
            disabled={disabled}
            data-shortcut={shortcutLabel || undefined}
            onClick={sync}
        >
            {label}
        </button>
    );
};

export const enum SyncMode {
    select,
    highlight,
}

const failedTimingWaveformSources = new Set<string>();

interface ISynchronizerProps {
    state: IState;
    dispatch: React.Dispatch<Action>;
    advancedState: AdvancedLyricsState;
    advancedDispatch: (action: AdvancedLyricsAction) => void;
    timingMode: LyricsWorkspaceMode;
}

export const Synchronizer: React.FC<ISynchronizerProps> = ({
    state,
    dispatch,
    advancedState,
    advancedDispatch,
    timingMode,
}) => {
    const self = useRef(Symbol(Synchronizer.name));

    const { selectIndex, currentIndex: highlightIndex, lyric } = state;

    const { lang, prefState, prefDispatch } = useContext(appContext);
    const keyBindings = useKeyBindings();
    const [mediaReady, setMediaReady] = useState(Boolean(audioRef.duration));
    const [playbackWords, setPlaybackWords] = useState<readonly WordCursor[]>([]);
    const [playbackRate, setPlaybackRate] = useState(audioRef.playbackRate);
    const [timingWaveformSource, setTimingWaveformSource] = useState(audioRef.src);
    const [timingWaveformFailed, setTimingWaveformFailed] = useState(() =>
        failedTimingWaveformSources.has(audioRef.src)
    );
    const [isHoldingWord, setIsHoldingWord] = useState(false);
    const timingWaveformRef = useRef<WaveformHandle>(null);
    const previewEndRef = useRef<number | null>(null);
    const holdingWordRef = useRef(false);
    const heldSyncKeyRef = useRef<string | null>(null);
    const wordFollowIntent = useRef<"capture" | "reveal" | "preserve" | null>("reveal");
    const wordFollowFrame = useRef(0);
    const previousWordLine = useRef(advancedState.cursor.lineIndex);
    const [wordFollowRevision, setWordFollowRevision] = useState(0);
    const requestWordFollow = useCallback((intent: "capture" | "reveal" | "preserve") => {
        wordFollowIntent.current = intent;
        setWordFollowRevision((revision) => revision + 1);
    }, []);
    const preserveWordQueueScroll = useCallback(() => {
        wordFollowIntent.current = "preserve";
        cancelAnimationFrame(wordFollowFrame.current);
    }, []);
    const syncShortcut = keyBindings[InputAction.Sync][0];
    const syncShortcutLabel = syncShortcut ? formatKeyBinding(syncShortcut) : null;
    const onTimingWaveformUnavailable = useCallback(() => {
        if (prefState.timingWaveformView === "spectrogram") {
            prefDispatch({ type: "timingWaveformView", payload: "waveform" });
            return;
        }
        if (timingWaveformSource) failedTimingWaveformSources.add(timingWaveformSource);
        setTimingWaveformFailed(true);
    }, [prefDispatch, prefState.timingWaveformView, timingWaveformSource]);
    const onTimingWaveformViewChange = useCallback((view: PrefState["timingWaveformView"]) => {
        if (view === "waveform" && timingWaveformSource) {
            failedTimingWaveformSources.delete(timingWaveformSource);
            setTimingWaveformFailed(false);
        }
        prefDispatch({ type: "timingWaveformView", payload: view });
    }, [prefDispatch, timingWaveformSource]);
    const onTimingWaveformZoomChange = useCallback((zoom: number) => {
        prefDispatch({ type: "timingWaveformZoom", payload: zoom });
    }, [prefDispatch]);
    const onTimingWaveformAmplitudeChange = useCallback((amplitude: number) => {
        prefDispatch({
            type: prefState.timingWaveformView === "spectrogram"
                ? "timingSpectrumBrightness"
                : "timingWaveformAmplitude",
            payload: amplitude,
        });
    }, [prefDispatch, prefState.timingWaveformView]);
    const onTimingWaveformHeightChange = useCallback((height: number) => {
        prefDispatch({ type: "timingWaveformHeight", payload: height });
    }, [prefDispatch]);

    const [syncMode, setSyncMode] = useState(() =>
        sessionStorage.getItem(SSK.syncMode) === SyncMode.highlight.toString() ? SyncMode.highlight : SyncMode.select
    );

    useEffect(() => {
        sessionStorage.setItem(SSK.syncMode, syncMode.toString());
    }, [syncMode]);

    const ul = useRef<HTMLUListElement>(null);
    const page = useRef<HTMLElement>(null);
    const [followLayoutRevision, setFollowLayoutRevision] = useState(0);

    const needScrollLine = {
        [SyncMode.select]: selectIndex,
        [SyncMode.highlight]: highlightIndex,
    }[syncMode];

    useEffect(() => {
        const updateLayout = (): void => setFollowLayoutRevision((revision) => revision + 1);
        const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateLayout);
        const toolbar = document.querySelector(".timing-toolbar");
        const footer = document.querySelector(".app-footer");
        const aside = document.querySelector(".aside-panel");
        for (const element of [ul.current, ul.current?.parentElement, toolbar, footer, aside]) {
            if (element) resizeObserver?.observe(element);
        }
        window.addEventListener("resize", updateLayout);
        window.addEventListener("orientationchange", updateLayout);
        window.visualViewport?.addEventListener("resize", updateLayout);
        return () => {
            resizeObserver?.disconnect();
            window.removeEventListener("resize", updateLayout);
            window.removeEventListener("orientationchange", updateLayout);
            window.visualViewport?.removeEventListener("resize", updateLayout);
        };
    }, []);

    useEffect(() => {
        if (timingMode === "word") return;
        const frameId = requestAnimationFrame(() => {
            const line = ul.current?.children[needScrollLine] as HTMLElement | undefined;
            if (line === undefined) {
                return;
            }

            const lineRect = line.getBoundingClientRect();
            const lineQueue = ul.current?.parentElement;
            if (
                prefState.lineCaptureMode === "waveform"
                && lineQueue
            ) {
                const queueRect = lineQueue.getBoundingClientRect();
                const visibleTop = queueRect.top + 8;
                const visibleBottom = queueRect.bottom - 8;
                if (lineRect.top < visibleTop || lineRect.bottom > visibleBottom) {
                    lineQueue.scrollTo({
                        top: lineQueue.scrollTop + lineRect.top - queueRect.top
                            - (lineQueue.clientHeight - lineRect.height) / 2,
                        behavior: "auto",
                    });
                }
                return;
            }
            const toolbarBottom = document.querySelector(".timing-toolbar")?.getBoundingClientRect().bottom ?? 0;
            page.current?.style.setProperty("--timing-controls-top", `${Math.round(toolbarBottom + 7)}px`);
            const asideBottom = matchMedia("(width <= 820px)").matches
                ? document.querySelector(".aside-panel")?.getBoundingClientRect().bottom ?? toolbarBottom
                : toolbarBottom;
            const viewportTop = window.visualViewport?.offsetTop ?? 0;
            const viewportBottom = viewportTop + (window.visualViewport?.height ?? window.innerHeight);
            const footerTop = document.querySelector(".app-footer")?.getBoundingClientRect().top ?? viewportBottom;
            const safeTop = Math.max(viewportTop + 8, toolbarBottom + 12, asideBottom + 8);
            const safeBottom = Math.min(viewportBottom - 8, footerTop - 12);
            page.current?.style.setProperty("--timing-follow-end-space", `${followEndSpace(safeTop, safeBottom)}px`);
            const top = centeredFollowOffset({
                lineTop: lineRect.top,
                lineHeight: lineRect.height,
                safeTop,
                safeBottom,
            });
            if (top === 0) return;
            window.scrollBy({
                top,
                behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
            });
        });

        return () => cancelAnimationFrame(frameId);
    }, [followLayoutRevision, needScrollLine, prefState.lineCaptureMode, syncMode, timingMode]);

    useEffect(() => {
        if (timingMode !== "word") return;
        const frameId = requestAnimationFrame(() => {
            window.scrollTo({
                top: 0,
                behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
            });
        });
        return () => cancelAnimationFrame(frameId);
    }, [timingMode]);

    useEffect(() => {
        if (timingMode !== "word") return;
        const lineChanged = previousWordLine.current !== advancedState.cursor.lineIndex;
        previousWordLine.current = advancedState.cursor.lineIndex;
        const intent = wordFollowIntent.current ?? (lineChanged ? "reveal" : null);
        wordFollowIntent.current = null;
        if (!intent || intent === "preserve") return;
        const frameId = requestAnimationFrame(() => {
            const list = ul.current;
            const container = list?.parentElement;
            const line = list?.children[advancedState.cursor.lineIndex] as HTMLElement | undefined;
            if (!list || !container || !line) return;
            const lineRect = line.getBoundingClientRect();
            const queueRect = container.getBoundingClientRect();
            const following = Array.from(list.children).slice(
                advancedState.cursor.lineIndex + 1,
                advancedState.cursor.lineIndex + 3,
            );
            const lookAheadHeight = following.reduce((height, row) => height + row.getBoundingClientRect().height, 0)
                + (2 - following.length) * lineRect.height;
            list.style.setProperty("--word-follow-tail-space", `${Math.ceil(lineRect.height * 2)}px`);
            const safeTop = queueRect.top + container.clientTop + 8;
            const viewport = {
                lineTop: lineRect.top,
                lineHeight: lineRect.height,
                safeTop,
                safeBottom: safeTop + container.clientHeight - 16,
                lookAheadHeight,
            };
            const offset = intent === "capture" ? lookAheadFollowOffset(viewport) : visibleFollowOffset(viewport);
            if (Math.abs(offset) < 1) return;
            container.scrollTo({
                top: container.scrollTop + offset,
                behavior: "instant",
            });
        });
        wordFollowFrame.current = frameId;
        return () => cancelAnimationFrame(frameId);
    }, [
        advancedState.cursor.lineIndex,
        wordFollowRevision,
        timingMode,
    ]);

    const wordPlaybackIndex = useMemo(
        () => advancedState.document ? buildWordPlaybackIndex(advancedState.document.lines) : [],
        [advancedState.document],
    );

    useEffect(() => {
        return currentTimePubSub.sub(self.current, (time) => {
            if (previewEndRef.current !== null && time * 1000 >= previewEndRef.current - 8) {
                audioRef.current?.pause();
                audioRef.currentTime = previewEndRef.current / 1000;
                previewEndRef.current = null;
            }
            dispatch({ type: ActionType.refresh, payload: time });
            if (timingMode === "word" && advancedState.document) {
                const next = wordsAtTimeFromIndex(wordPlaybackIndex, Math.round(time * 1000));
                setPlaybackWords((current) =>
                    current.length === next.length
                        && current.every((cursor, index) => cursorsEqual(cursor, next[index]))
                        ? current
                        : next
                );
            }
        });
    }, [advancedState.document, dispatch, timingMode, wordPlaybackIndex]);

    useEffect(() =>
        audioStatePubSub.sub(self.current, (state) => {
            if (state.type === AudioActionType.getDuration) {
                setMediaReady(state.payload > 0);
                const source = audioRef.src;
                setTimingWaveformSource(source);
                setTimingWaveformFailed(failedTimingWaveformSources.has(source));
            }
            if (state.type === AudioActionType.rateChange) setPlaybackRate(state.payload);
        }), []);

    const captureTimeMs = useCallback(
        () => Math.max(0, Math.round(audioRef.currentTime * 1000 + prefState.wordTimingCompensationMs)),
        [
            prefState.wordTimingCompensationMs,
        ],
    );

    const stampWordAt = useCallback((timeMs: number) => {
        if (timingMode === "word" && advancedState.document) {
            const line = advancedState.document.lines[advancedState.cursor.lineIndex];
            if (!line) return;
            const next = !advancedState.cursor.end && advancedState.cursor.wordIndex === line.words.length - 1
                ? advancedState.cursor
                : nextSyncWordCursor(advancedState.document, advancedState.cursor, 1);
            requestWordFollow("capture");
            advancedDispatch({ type: AdvancedActionType.stamp, payload: Math.max(0, Math.round(timeMs)) });
            if (next.lineIndex !== state.selectIndex) {
                dispatch({ type: ActionType.select, payload: () => next.lineIndex });
            }
        }
    }, [
        advancedDispatch,
        advancedState.cursor,
        advancedState.document,
        dispatch,
        requestWordFollow,
        state.selectIndex,
        timingMode,
    ]);

    const syncWordStart = useCallback(() => {
        if (!audioRef.duration || timingMode !== "word" || !advancedState.document) return;
        requestWordFollow("capture");
        advancedDispatch({ type: AdvancedActionType.syncStart, payload: captureTimeMs() });
    }, [advancedDispatch, advancedState.document, captureTimeMs, requestWordFollow, timingMode]);

    const syncWordEnd = useCallback(() => {
        if (!audioRef.duration || timingMode !== "word" || !advancedState.document) return;
        const next = nextSyncWordCursor(advancedState.document, advancedState.cursor, 1);
        requestWordFollow("capture");
        advancedDispatch({ type: AdvancedActionType.syncEnd, payload: captureTimeMs() });
        if (next.lineIndex !== state.selectIndex) {
            dispatch({ type: ActionType.select, payload: () => next.lineIndex });
        }
    }, [
        advancedDispatch,
        advancedState.cursor,
        advancedState.document,
        captureTimeMs,
        dispatch,
        requestWordFollow,
        state.selectIndex,
        timingMode,
    ]);

    const sync = useCallback(() => {
        if (!audioRef.duration) return;

        if (timingMode === "word") {
            stampWordAt(captureTimeMs());
            return;
        }

        dispatch({
            type: ActionType.next,
            payload: audioRef.currentTime,
        });
    }, [
        captureTimeMs,
        dispatch,
        stampWordAt,
        timingMode,
    ]);

    const seekTimingWaveform = useCallback((timeSeconds: number) => {
        previewEndRef.current = null;
        audioRef.currentTime = timeSeconds;
        currentTimePubSub.pub(timeSeconds);
    }, []);

    const captureWordFromWaveform = useCallback((timeSeconds: number) => {
        seekTimingWaveform(timeSeconds);
        stampWordAt(timeSeconds * 1000);
    }, [seekTimingWaveform, stampWordAt]);

    const setLineStartFromWaveform = useCallback((timeSeconds: number) => {
        dispatch({
            type: prefState.lineWaveformAutoAdvance ? ActionType.next : ActionType.time,
            payload: timeSeconds,
        });
        if (prefState.lineWaveformPlayAfterSet) {
            seekTimingWaveform(timeSeconds);
            void audioRef.current?.play().catch(() => undefined);
        }
    }, [dispatch, prefState.lineWaveformAutoAdvance, prefState.lineWaveformPlayAfterSet, seekTimingWaveform]);

    useEffect(() => {
        const wordMode = timingMode === "word" && prefState.wordCaptureMode === "waveform";
        const lineMode = timingMode === "line" && prefState.lineCaptureMode === "waveform";
        if (!wordMode && !lineMode) return;
        return setWaveformTimingHandler(wordMode ? captureWordFromWaveform : setLineStartFromWaveform);
    }, [
        captureWordFromWaveform,
        prefState.lineCaptureMode,
        prefState.wordCaptureMode,
        setLineStartFromWaveform,
        timingMode,
    ]);

    const startWordHold = useCallback(() => {
        if (!audioRef.duration || timingMode !== "word" || !advancedState.document || holdingWordRef.current) return;
        holdingWordRef.current = true;
        setIsHoldingWord(true);
        requestWordFollow("capture");
        advancedDispatch({ type: AdvancedActionType.startHold, payload: captureTimeMs() });
    }, [advancedDispatch, advancedState.document, captureTimeMs, requestWordFollow, timingMode]);

    const finishWordHold = useCallback(() => {
        if (!holdingWordRef.current || timingMode !== "word" || !advancedState.document) return;
        holdingWordRef.current = false;
        setIsHoldingWord(false);
        const next = nextSyncWordCursor(advancedState.document, advancedState.cursor, 1);
        requestWordFollow("capture");
        advancedDispatch({ type: AdvancedActionType.finishHold, payload: captureTimeMs() });
        if (next.lineIndex !== state.selectIndex) {
            dispatch({ type: ActionType.select, payload: () => next.lineIndex });
        }
    }, [
        advancedDispatch,
        advancedState.cursor,
        advancedState.document,
        captureTimeMs,
        dispatch,
        requestWordFollow,
        state.selectIndex,
        timingMode,
    ]);

    const cancelWordHold = useCallback(() => {
        if (!holdingWordRef.current) return;
        holdingWordRef.current = false;
        heldSyncKeyRef.current = null;
        setIsHoldingWord(false);
        advancedDispatch({ type: AdvancedActionType.undo, payload: undefined });
    }, [advancedDispatch]);

    const adjust = useCallback(
        (ev: KeyboardEvent | React.MouseEvent, offset: number, index: number) => {
            const selectTime = timingMode === "word"
                ? advancedState.document?.lines[advancedState.cursor.lineIndex]?.words[advancedState.cursor.wordIndex]
                        ?.startMs === undefined
                    ? undefined
                    : advancedState.document.lines[advancedState.cursor.lineIndex].words[advancedState.cursor.wordIndex]
                        .startMs! / 1000
                : lyric[index]?.time;

            if (selectTime === undefined) {
                return;
            }
            let nextTime: number;
            if (offset === 0) {
                if (!audioRef.duration) return;
                nextTime = audioRef.currentTime;
            } else {
                let scaledOffset = offset;
                if (ev.altKey) scaledOffset *= 0.2;
                if (ev.shiftKey) scaledOffset *= 0.5;
                nextTime = Math.max(0, selectTime + scaledOffset);
                if (audioRef.duration) nextTime = Math.min(audioRef.duration, nextTime);
            }
            if (timingMode === "word") {
                advancedDispatch({
                    type: AdvancedActionType.adjustTime,
                    payload: Math.round((nextTime - selectTime) * 1000),
                });
            } else {
                dispatch({ type: ActionType.time, payload: nextTime });
            }
        },
        [advancedDispatch, advancedState.cursor, advancedState.document, dispatch, lyric, timingMode],
    );

    const selectWord = useCallback((cursor: WordCursor, follow: "reveal" | "preserve" = "reveal") => {
        const document = advancedState.document;
        if (!document || document.lines.length === 0) return;
        const clampedLineIndex = guard(cursor.lineIndex, 0, document.lines.length - 1);
        const targetLine = document.lines[clampedLineIndex];
        const next = {
            lineIndex: clampedLineIndex,
            wordIndex: guard(
                cursor.wordIndex,
                0,
                Math.max(0, (targetLine?.words.length ?? 1) - 1),
            ),
        };
        requestWordFollow(follow);
        advancedDispatch({ type: AdvancedActionType.select, payload: next });
        dispatch({ type: ActionType.select, payload: () => next.lineIndex });
        const time = targetLine?.words[next.wordIndex]?.startMs;
        if (prefState.interactiveSeek && time !== undefined) audioRef.currentTime = time / 1000;
    }, [advancedDispatch, advancedState.document, dispatch, prefState.interactiveSeek, requestWordFollow]);

    const selectLine = useCallback(
        (getIndex: (index: number) => number) => {
            const nextIndex = guard(getIndex(selectIndex), 0, lyric.length - 1);
            dispatch({ type: ActionType.select, payload: () => nextIndex });

            const time = lyric[nextIndex]?.time;
            if (prefState.interactiveSeek && time !== undefined) {
                audioRef.currentTime = time;
            }
        },
        [dispatch, lyric, prefState.interactiveSeek, selectIndex],
    );

    const previewRange = useCallback((startMs: number | undefined, endMs: number | undefined) => {
        if (
            !audioRef.current || !audioRef.duration || startMs === undefined || endMs === undefined || endMs <= startMs
        ) {
            return;
        }
        previewEndRef.current = endMs;
        audioRef.currentTime = startMs / 1000;
        void audioRef.current.play().catch(() => {
            previewEndRef.current = null;
        });
    }, []);

    const previewSelectedWord = useCallback(() => {
        const document = advancedState.document;
        const line = document?.lines[advancedState.cursor.lineIndex];
        const word = line?.words[advancedState.cursor.wordIndex];
        if (!document || !line || !word) return;
        const nextStart = line.words.slice(advancedState.cursor.wordIndex + 1)
            .find((candidate) => candidate.startMs !== undefined)?.startMs;
        const previewStart = word.startMs === undefined
            ? undefined
            : Math.max(0, word.startMs - prefState.wordPreviewLeadMs);
        previewRange(previewStart, word.endMs ?? nextStart ?? line.endMs);
    }, [advancedState.cursor, advancedState.document, prefState.wordPreviewLeadMs, previewRange]);

    const previewSelectedLine = useCallback(() => {
        const document = advancedState.document;
        const line = document?.lines[advancedState.cursor.lineIndex];
        if (!document || !line) return;
        const nextLineStart = document.lines.slice(advancedState.cursor.lineIndex + 1)
            .find((candidate) => candidate.startMs !== undefined)?.startMs;
        let lastWordEnd: number | undefined;
        for (let i = line.words.length - 1; i >= 0; i -= 1) {
            if (line.words[i].endMs !== undefined) {
                lastWordEnd = line.words[i].endMs;
                break;
            }
        }
        const fallbackEnd = line.startMs === undefined
            ? undefined
            : Math.min(audioRef.duration * 1000, line.startMs + 4000);
        const previewStart = line.startMs === undefined
            ? undefined
            : Math.max(0, line.startMs - prefState.wordPreviewLeadMs);
        previewRange(previewStart, line.endMs ?? lastWordEnd ?? nextLineStart ?? fallbackEnd);
    }, [advancedState.cursor.lineIndex, advancedState.document, prefState.wordPreviewLeadMs, previewRange]);

    const previewWaveformSelection = useCallback(() => {
        const document = advancedState.document;
        const line = document?.lines[advancedState.cursor.lineIndex];
        const word = line?.words[advancedState.cursor.wordIndex];
        if (!document || !line || !word || word.startMs === undefined) {
            previewSelectedLine();
            return;
        }
        const nextStart = line.words.slice(advancedState.cursor.wordIndex + 1)
            .find((candidate) => candidate.startMs !== undefined)?.startMs;
        previewRange(word.startMs, word.endMs ?? nextStart ?? line.endMs);
    }, [advancedState.cursor, advancedState.document, previewRange, previewSelectedLine]);

    const previewLineWaveformSelection = useCallback(() => {
        if (!audioRef.duration) return;
        const lineStart = lyric[selectIndex]?.time ?? audioRef.currentTime;
        previewEndRef.current = null;
        audioRef.currentTime = lineStart;
        currentTimePubSub.pub(lineStart);
        void audioRef.current?.play().catch(() => undefined);
    }, [lyric, selectIndex]);

    useEffect(() => {
        function onKeydown(ev: KeyboardEvent): void {
            if (ev.key === "Escape" && holdingWordRef.current) {
                ev.preventDefault();
                cancelWordHold();
                return;
            }

            if (shouldIgnoreGlobalShortcut(ev)) {
                return;
            }

            const ctrlOrMeta = ev.ctrlKey || ev.metaKey;
            if (ctrlOrMeta && ev.code === "KeyZ") {
                ev.preventDefault();
                if (timingMode === "word") {
                    advancedDispatch({
                        type: ev.shiftKey ? AdvancedActionType.redo : AdvancedActionType.undo,
                        payload: undefined,
                    });
                } else {
                    dispatch({
                        type: ev.shiftKey ? ActionType.redo : ActionType.undo,
                        payload: undefined,
                    });
                }
                return;
            }
            if (ctrlOrMeta && ev.code === "KeyY") {
                ev.preventDefault();
                if (timingMode === "word") {
                    advancedDispatch({ type: AdvancedActionType.redo, payload: undefined });
                } else {
                    dispatch({ type: ActionType.redo, payload: undefined });
                }
                return;
            }

            const waveformMode = timingMode === "word"
                ? prefState.wordCaptureMode === "waveform"
                : prefState.lineCaptureMode === "waveform";
            if (waveformMode && !ctrlOrMeta && !ev.altKey) {
                if (ev.code === "KeyS") {
                    ev.preventDefault();
                    if (!ev.repeat) {
                        if (timingMode === "word") previewWaveformSelection();
                        else previewLineWaveformSelection();
                    }
                    return;
                }
                if (ev.code === "KeyF") {
                    ev.preventDefault();
                    if (!ev.repeat) timingWaveformRef.current?.scrollPage(ev.shiftKey ? -1 : 1);
                    return;
                }
                if (ev.code === "KeyG") {
                    ev.preventDefault();
                    if (!ev.repeat) {
                        if (timingMode === "word" && audioRef.duration) captureWaveformTime(audioRef.currentTime);
                        else if (timingMode === "line" && lyric[selectIndex]?.time !== undefined) {
                            selectLine((index) => index + 1);
                        }
                    }
                    return;
                }
            }

            if (
                timingMode === "word" && prefState.wordCaptureMode === "tap" && !ctrlOrMeta && !ev.altKey
                && !ev.shiftKey
            ) {
                if (ev.code === "KeyF") {
                    ev.preventDefault();
                    if (!ev.repeat) syncWordStart();
                    return;
                }
                if (ev.code === "KeyG") {
                    ev.preventDefault();
                    if (!ev.repeat) sync();
                    return;
                }
                if (ev.code === "KeyE") {
                    ev.preventDefault();
                    if (!ev.repeat) syncWordEnd();
                    return;
                }
            }

            const action = getMatchedAction(ev, keyBindings);

            switch (action) {
                case InputAction.Sync:
                    ev.preventDefault();
                    if (ev.repeat) {
                        break;
                    }
                    if (timingMode === "word" && prefState.wordCaptureMode === "waveform") {
                        break;
                    }
                    if (timingMode === "line" && prefState.lineCaptureMode === "waveform") {
                        break;
                    }
                    if (timingMode === "word" && prefState.wordCaptureMode === "hold") {
                        heldSyncKeyRef.current = ev.code;
                        startWordHold();
                    } else {
                        sync();
                    }
                    break;
                case InputAction.DeleteTime:
                    ev.preventDefault();
                    if (timingMode === "word") {
                        advancedDispatch({ type: AdvancedActionType.deleteTime, payload: undefined });
                    } else {
                        dispatch({ type: ActionType.deleteTime, payload: undefined });
                    }
                    break;
                case InputAction.ResetOffset:
                    ev.preventDefault();
                    adjust(ev, 0, selectIndex);
                    break;
                case InputAction.DecreaseOffset:
                    ev.preventDefault();
                    adjust(ev, -prefState.fineTuneMs / 1000, selectIndex);
                    break;
                case InputAction.IncreaseOffset:
                    ev.preventDefault();
                    adjust(ev, prefState.fineTuneMs / 1000, selectIndex);
                    break;
                case InputAction.PrevLine:
                    ev.preventDefault();
                    if (timingMode === "word" && advancedState.document) {
                        selectWord(nextSyncWordCursor(advancedState.document, advancedState.cursor, -1));
                    } else selectLine((index) => index - 1);
                    break;
                case InputAction.NextLine:
                    ev.preventDefault();
                    if (timingMode === "word" && advancedState.document) {
                        selectWord(nextSyncWordCursor(advancedState.document, advancedState.cursor, 1));
                    } else selectLine((index) => index + 1);
                    break;
                case InputAction.FirstLine:
                    ev.preventDefault();
                    if (timingMode === "word") selectWord({ lineIndex: 0, wordIndex: 0 });
                    else selectLine(() => 0);
                    break;
                case InputAction.LastLine:
                    ev.preventDefault();
                    if (timingMode === "word" && advancedState.document && advancedState.document.lines.length > 0) {
                        const lineIndex = advancedState.document.lines.length - 1;
                        selectWord({
                            lineIndex,
                            wordIndex: Math.max(0, (advancedState.document.lines[lineIndex]?.words.length ?? 1) - 1),
                        });
                    } else selectLine(() => Infinity);
                    break;
                case InputAction.PageUp:
                    ev.preventDefault();
                    if (timingMode === "word") {
                        selectWord({ lineIndex: advancedState.cursor.lineIndex - 10, wordIndex: 0 });
                    } else selectLine((index) => index - 10);
                    break;
                case InputAction.PageDown:
                    ev.preventDefault();
                    if (timingMode === "word") {
                        selectWord({ lineIndex: advancedState.cursor.lineIndex + 10, wordIndex: 0 });
                    } else selectLine((index) => index + 10);
                    break;
            }
        }

        function onKeyup(ev: KeyboardEvent): void {
            if (heldSyncKeyRef.current === ev.code && holdingWordRef.current) {
                ev.preventDefault();
                heldSyncKeyRef.current = null;
                finishWordHold();
            }
        }

        function onWindowBlur(): void {
            if (holdingWordRef.current) cancelWordHold();
        }

        document.addEventListener("keydown", onKeydown);
        document.addEventListener("keyup", onKeyup);
        window.addEventListener("blur", onWindowBlur);

        return (): void => {
            document.removeEventListener("keydown", onKeydown);
            document.removeEventListener("keyup", onKeyup);
            window.removeEventListener("blur", onWindowBlur);
        };
    }, [
        adjust,
        advancedDispatch,
        advancedState.cursor,
        advancedState.document,
        cancelWordHold,
        dispatch,
        keyBindings,
        prefState.fineTuneMs,
        prefState.lineCaptureMode,
        prefState.wordCaptureMode,
        previewLineWaveformSelection,
        previewWaveformSelection,
        selectIndex,
        selectLine,
        selectWord,
        sync,
        syncWordEnd,
        syncWordStart,
        startWordHold,
        finishWordHold,
        timingMode,
    ]);

    useEffect(() => () => {
        if (holdingWordRef.current) {
            advancedDispatch({ type: AdvancedActionType.undo, payload: undefined });
        }
    }, [advancedDispatch]);

    const onLineClick = useCallback(
        (ev: React.MouseEvent<HTMLUListElement & HTMLLIElement>) => {
            ev.stopPropagation();

            const target = ev.target as HTMLElement;
            const lineTarget = target.closest<HTMLElement>(".line");
            if (!lineTarget) return;
            const lineKey = Number.parseInt(lineTarget.dataset.key!, 10) || 0;

            const wordTarget = target.closest<HTMLElement>(".timed-word");
            if (timingMode === "word" && wordTarget) {
                selectWord({
                    lineIndex: Number.parseInt(wordTarget.dataset.line!, 10),
                    wordIndex: Number.parseInt(wordTarget.dataset.word!, 10),
                }, "preserve");
                return;
            }

            if (timingMode === "word") selectWord({ lineIndex: lineKey, wordIndex: 0 }, "preserve");
            else selectLine(() => lineKey);

            if (target.closest(".line-time-play") && lyric[lineKey]?.time !== undefined && audioRef.duration) {
                previewEndRef.current = null;
                audioRef.currentTime = lyric[lineKey].time!;
                currentTimePubSub.pub(lyric[lineKey].time!);
                void audioRef.current?.play().catch(() => undefined);
            }
        },
        [lyric, selectLine, selectWord, timingMode],
    );

    const onLineDoubleClick = useCallback(
        (ev: React.MouseEvent<HTMLUListElement | HTMLLIElement>) => {
            ev.stopPropagation();

            if (!audioRef.duration) {
                return;
            }

            const target = ev.target as HTMLElement;

            const wordTarget = target.closest<HTMLElement>(".timed-word");
            if (timingMode === "word" && wordTarget && advancedState.document) {
                const cursor = {
                    lineIndex: Number.parseInt(wordTarget.dataset.line!, 10),
                    wordIndex: Number.parseInt(wordTarget.dataset.word!, 10),
                };
                const time = advancedState.document.lines[cursor.lineIndex]?.words[cursor.wordIndex]?.startMs;
                if (time !== undefined) {
                    selectWord(cursor, "preserve");
                    audioRef.currentTime = time / 1000;
                }
                return;
            }

            const lineTarget = target.closest<HTMLElement>(".line");
            if (lineTarget) {
                const key = Number.parseInt(lineTarget.dataset.key!, 10);
                const time = lyric[key]?.time;
                if (time !== undefined) {
                    if (timingMode === "word") selectWord({ lineIndex: key, wordIndex: 0 });
                    else selectLine(() => key);
                    audioRef.currentTime = time;
                }
            }
        },
        [advancedState.document, lyric, selectLine, selectWord, timingMode],
    );

    const lineIssues = useMemo(
        () => lyric.map((_, index) => timingIssueAt(lyric, index, timingMode === "word")),
        [lyric, timingMode],
    );

    const wordIssuesByLine = useMemo(
        () =>
            timingMode === "word" && advancedState.document
                ? advancedState.document.lines.map((line, lineIndex) =>
                    line.words.map((_, wordIndex) => wordTimingIssueAt(advancedState.document!, lineIndex, wordIndex))
                )
                : [],
        [advancedState.document, timingMode],
    );

    const playbackWordsByLine = useMemo(() => {
        const grouped = new Map<number, number[]>();
        for (const cursor of playbackWords) {
            const list = grouped.get(cursor.lineIndex);
            if (list) list.push(cursor.wordIndex);
            else grouped.set(cursor.lineIndex, [cursor.wordIndex]);
        }
        return grouped;
    }, [playbackWords]);

    const LyricLineIter = useCallback(
        (line: Readonly<ILyric>, index: number) => {
            const select = index === selectIndex;
            const linePlaybackWords = playbackWordsByLine.get(index) ?? EMPTY_PLAYBACK_WORDS;
            const highlight = timingMode === "word" ? linePlaybackWords.length > 0 : index === highlightIndex;
            const issue = lineIssues[index] ?? null;
            const advancedLine = timingMode === "word" ? advancedState.document?.lines[index] : undefined;
            const lineWordIssues = timingMode === "word" ? wordIssuesByLine[index] : undefined;
            const firstIssue = lineWordIssues?.find((candidate): candidate is WordTimingIssue => candidate !== null)
                ?? null;
            const timingPending = timingMode === "word" && !!advancedLine && isWordTimingPending(advancedLine);
            const error = issue !== null || firstIssue !== null || timingPending;
            const issueLabel = issue
                ? lang.timing[issue]
                : firstIssue
                ? wordIssueLabel(firstIssue, lang.advancedLyrics)
                : timingPending
                ? lang.advancedLyrics.wordTimingPending
                : undefined;

            const className = Object.entries({
                line: true,
                select,
                highlight,
                error,
                [`error-${issue}`]: issue !== null,
                "word-timing-pending": timingPending,
            })
                .reduce<string[]>((p, [name, value]) => {
                    if (value) {
                        p.push(name);
                    }
                    return p;
                }, [])
                .join(STRINGS.space);

            return (
                <LyricLine
                    key={index}
                    index={index}
                    className={className}
                    line={line}
                    select={select}
                    showLiveTime={timingMode === "line"}
                    highlight={highlight}
                    prefState={prefState}
                    issueLabel={issueLabel}
                    timingPending={timingPending && issue === null && firstIssue === null}
                    advancedLine={advancedLine}
                    wordIssues={lineWordIssues}
                    selectedWord={advancedState.cursor.lineIndex === index ? advancedState.cursor.wordIndex : undefined}
                    playbackWords={linePlaybackWords}
                    language={lang.advancedLyrics}
                />
            );
        },
        [
            advancedState.cursor,
            advancedState.document,
            highlightIndex,
            lang.advancedLyrics,
            lang.timing,
            lineIssues,
            playbackWordsByLine,
            prefState,
            selectIndex,
            timingMode,
            wordIssuesByLine,
        ],
    );

    const ulClassName = prefState.screenButton ? "lyric-list on-screen-button" : "lyric-list";
    const selectedWord = timingMode === "word"
        ? advancedState.document?.lines[advancedState.cursor.lineIndex]?.words[advancedState.cursor.wordIndex]
        : undefined;
    const selectedAdvancedLine = timingMode === "word"
        ? advancedState.document?.lines[advancedState.cursor.lineIndex]
        : undefined;
    const dedicatedWaveformMode = timingMode === "word"
        ? prefState.wordCaptureMode === "waveform"
        : prefState.lineCaptureMode === "waveform";
    const waveformLineText = timingMode === "word"
        ? selectedAdvancedLine ? advancedLineText(selectedAdvancedLine) : ""
        : lyric[selectIndex]?.text || "";
    const waveformUnitText = timingMode === "word"
        ? selectedWord?.text || ""
        : `${selectIndex + 1} / ${lyric.length}`;
    const waveformStartMs = timingMode === "word"
        ? selectedWord?.startMs
        : lyric[selectIndex]?.time === undefined
        ? undefined
        : lyric[selectIndex].time * 1000;
    const selectedTime = timingMode === "word"
        ? selectedWord?.startMs === undefined ? undefined : selectedWord.startMs / 1000
        : lyric[selectIndex]?.time;
    const selectedTimeLabel = selectedTime === undefined
        ? lang.timing.noTimestamp
        : formatTimeTag(selectedTime, prefState.fixed, false);

    return (
        <section
            ref={page}
            className={`timing-page ${syncMode === SyncMode.highlight ? "follow-playback" : "follow-selection"}${
                timingMode === "word" ? " word-mode" : " line-mode"
            }${dedicatedWaveformMode ? " waveform-capture" : ""}${
                timingMode === "line" && dedicatedWaveformMode ? " line-waveform-mode" : ""
            }`}
        >
            <header className="timing-toolbar">
                <div className="timing-selection">
                    <span>
                        {timingMode === "word" && advancedState.document
                            ? lang.advancedLyrics.wordProgress
                                .replace("%d", (advancedState.cursor.wordIndex + 1).toString())
                                .replace(
                                    "%t",
                                    (advancedState.document.lines[advancedState.cursor.lineIndex]?.words.length ?? 0)
                                        .toString(),
                                )
                            : `${selectIndex + 1} / ${lyric.length}`}
                    </span>
                    <strong>
                        {timingMode === "word"
                            ? selectedWord?.text || lang.timing.emptyLine
                            : lyric[selectIndex]?.text || lang.timing.emptyLine}
                    </strong>
                    <div className="timing-fine-tune">
                        <button
                            type="button"
                            title={lang.keybindings.actions.decreaseOffset}
                            aria-label={`${lang.keybindings.actions.decreaseOffset}: ${prefState.fineTuneMs} ms`}
                            onClick={(event) => adjust(event, -prefState.fineTuneMs / 1000, selectIndex)}
                            disabled={selectedTime === undefined}
                        >
                            −{prefState.fineTuneMs} ms
                        </button>
                        <time>{selectedTimeLabel}</time>
                        <button
                            type="button"
                            title={lang.keybindings.actions.increaseOffset}
                            aria-label={`${lang.keybindings.actions.increaseOffset}: ${prefState.fineTuneMs} ms`}
                            onClick={(event) => adjust(event, prefState.fineTuneMs / 1000, selectIndex)}
                            disabled={selectedTime === undefined}
                        >
                            +{prefState.fineTuneMs} ms
                        </button>
                    </div>
                </div>
                {timingMode === "line" && (
                    <div className="line-capture-mode" role="group" aria-label={lang.timing.captureMode}>
                        <button
                            type="button"
                            className={prefState.lineCaptureMode === "standard" ? "active" : ""}
                            aria-pressed={prefState.lineCaptureMode === "standard"}
                            onClick={() =>
                                prefDispatch({ type: "lineCaptureMode", payload: "standard" })}
                        >
                            {lang.timing.standardCaptureMode}
                        </button>
                        <button
                            type="button"
                            className={prefState.lineCaptureMode === "waveform" ? "active" : ""}
                            aria-pressed={prefState.lineCaptureMode === "waveform"}
                            onClick={() =>
                                prefDispatch({ type: "lineCaptureMode", payload: "waveform" })}
                        >
                            {lang.timing.waveformCaptureMode}
                        </button>
                    </div>
                )}
                <div className="timing-actions">
                    {timingMode === "word" && (
                        <a className="timing-review-export" href={prependHash(ROUTER.editor)}>
                            {lang.advancedLyrics.reviewAndExport}
                        </a>
                    )}
                    <button
                        type="button"
                        onClick={() =>
                            timingMode === "word"
                                ? advancedDispatch({ type: AdvancedActionType.undo, payload: undefined })
                                : dispatch({ type: ActionType.undo, payload: undefined })}
                        disabled={timingMode === "word"
                            ? advancedState.historyPast.length === 0
                            : state.historyPast.length === 0}
                    >
                        {lang.timing.undo}
                    </button>
                    <button
                        type="button"
                        onClick={() =>
                            timingMode === "word"
                                ? advancedDispatch({ type: AdvancedActionType.redo, payload: undefined })
                                : dispatch({ type: ActionType.redo, payload: undefined })}
                        disabled={timingMode === "word"
                            ? advancedState.historyFuture.length === 0
                            : state.historyFuture.length === 0}
                    >
                        {lang.timing.redo}
                    </button>
                    {timingMode === "line" && prefState.lineCaptureMode === "standard" && (
                        <button className="timing-capture" type="button" onClick={sync} disabled={!mediaReady}>
                            <span>{lang.keybindings.actions.sync}</span>
                            {syncShortcutLabel && <kbd>{syncShortcutLabel}</kbd>}
                        </button>
                    )}
                </div>
            </header>
            {dedicatedWaveformMode && (
                mediaReady && timingWaveformSource && !timingWaveformFailed
                    ? (
                        <TimingWaveformPanel
                            key={timingWaveformSource}
                            ref={timingWaveformRef}
                            source={timingWaveformSource}
                            themeColor={prefState.themeColor}
                            timingUnit={timingMode}
                            selectionKey={timingMode === "word"
                                ? `${advancedState.cursor.lineIndex}:${advancedState.cursor.wordIndex}`
                                : `${selectIndex}`}
                            lineText={waveformLineText}
                            wordText={waveformUnitText}
                            wordStartMs={waveformStartMs}
                            fixed={prefState.fixed}
                            view={prefState.timingWaveformView}
                            zoom={prefState.timingWaveformZoom}
                            amplitude={prefState.timingWaveformView === "spectrogram"
                                ? prefState.timingSpectrumBrightness
                                : prefState.timingWaveformAmplitude}
                            heightPercent={prefState.timingWaveformHeight}
                            lineAutoAdvance={prefState.lineWaveformAutoAdvance}
                            linePlayAfterSet={prefState.lineWaveformPlayAfterSet}
                            language={lang.advancedLyrics}
                            onCapture={captureWaveformTime}
                            onUnavailable={onTimingWaveformUnavailable}
                            onViewChange={onTimingWaveformViewChange}
                            onZoomChange={onTimingWaveformZoomChange}
                            onAmplitudeChange={onTimingWaveformAmplitudeChange}
                            onHeightChange={onTimingWaveformHeightChange}
                        />
                    )
                    : (
                        <section className="word-waveform-empty">
                            <strong>{waveformLineText || "—"}</strong>
                            <span>
                                {timingWaveformFailed
                                    ? lang.advancedLyrics.waveformUnavailable
                                    : lang.advancedLyrics.waveformLoadMedia}
                            </span>
                            {timingWaveformFailed && mediaReady && (
                                <button
                                    type="button"
                                    className="word-waveform-fallback-track"
                                    aria-label={lang.advancedLyrics.waveformFallbackAction}
                                    onClick={(event) => {
                                        const bounds = event.currentTarget.getBoundingClientRect();
                                        const time = Math.max(
                                            0,
                                            Math.min(
                                                audioRef.duration,
                                                (event.clientX - bounds.left) / bounds.width * audioRef.duration,
                                            ),
                                        );
                                        captureWaveformTime(time);
                                    }}
                                >
                                    <i
                                        style={{
                                            left: `${
                                                Math.max(
                                                    0,
                                                    Math.min(100, (waveformStartMs || 0) / 10 / audioRef.duration),
                                                )
                                            }%`,
                                        }}
                                    />
                                </button>
                            )}
                            {timingWaveformFailed && (
                                <button
                                    type="button"
                                    onClick={() => {
                                        failedTimingWaveformSources.delete(timingWaveformSource);
                                        setTimingWaveformFailed(false);
                                    }}
                                >
                                    {lang.advancedLyrics.waveformRetry}
                                </button>
                            )}
                        </section>
                    )
            )}
            {timingMode === "word" && advancedState.document && (
                <WordTimingStage
                    document={advancedState.document}
                    cursor={advancedState.cursor}
                    playbackWords={playbackWords}
                    fixed={prefState.fixed}
                    mediaReady={mediaReady}
                    syncShortcutLabel={syncShortcutLabel}
                    shortcuts={[
                        ...(prefState.wordCaptureMode === "tap"
                            ? [
                                { key: "F", label: lang.advancedLyrics.syncStart },
                                { key: "G", label: lang.advancedLyrics.syncContinuous },
                                { key: "E", label: lang.advancedLyrics.syncEnd },
                            ]
                            : []),
                        {
                            key: keyBindings[InputAction.PrevLine][0]
                                ? formatKeyBinding(keyBindings[InputAction.PrevLine][0])
                                : "",
                            label: lang.advancedLyrics.previousWord,
                        },
                        {
                            key: keyBindings[InputAction.NextLine][0]
                                ? formatKeyBinding(keyBindings[InputAction.NextLine][0])
                                : "",
                            label: lang.advancedLyrics.nextWord,
                        },
                        {
                            key: keyBindings[InputAction.DeleteTime][0]
                                ? formatKeyBinding(keyBindings[InputAction.DeleteTime][0])
                                : "",
                            label: lang.advancedLyrics.deleteWordTime,
                        },
                        { key: /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘ Z" : "Ctrl Z", label: lang.timing.undo },
                    ]}
                    captureMode={prefState.wordCaptureMode}
                    isHolding={isHoldingWord}
                    compensationMs={prefState.wordTimingCompensationMs}
                    previewLeadMs={prefState.wordPreviewLeadMs}
                    playbackRate={playbackRate}
                    language={lang.advancedLyrics}
                    onSelectWord={selectWord}
                    onStamp={sync}
                    onSyncStart={syncWordStart}
                    onSyncEnd={syncWordEnd}
                    onHoldStart={startWordHold}
                    onHoldEnd={finishWordHold}
                    onHoldCancel={cancelWordHold}
                    onCaptureModeChange={(captureMode) => {
                        if (holdingWordRef.current) finishWordHold();
                        prefDispatch({ type: "wordCaptureMode", payload: captureMode });
                    }}
                    onCompensationChange={(milliseconds) =>
                        prefDispatch({
                            type: "wordTimingCompensationMs",
                            payload: Math.max(-500, Math.min(500, milliseconds || 0)),
                        })}
                    onPreviewLeadChange={(milliseconds) =>
                        prefDispatch({ type: "wordPreviewLeadMs", payload: milliseconds })}
                    onPlaybackRateChange={(rate) => {
                        setPlaybackRate(rate);
                        audioRef.playbackRate = rate;
                    }}
                    onSeek={(milliseconds) => {
                        previewEndRef.current = null;
                        audioRef.currentTime = milliseconds / 1000;
                    }}
                    onDistributeLine={(startMs, endMs) =>
                        advancedDispatch({
                            type: AdvancedActionType.distributeLine,
                            payload: { lineIndex: advancedState.cursor.lineIndex, startMs, endMs },
                        })}
                    onRestartFromWord={() =>
                        advancedDispatch({
                            type: AdvancedActionType.clearLineFromCursor,
                            payload: advancedState.cursor,
                        })}
                    onNextUntimed={() =>
                        advancedState.document
                        && selectWord(nextUntimedWordCursor(advancedState.document, advancedState.cursor))}
                    onPrevious={() =>
                        advancedState.document
                        && selectWord(nextSyncWordCursor(advancedState.document, advancedState.cursor, -1))}
                    onNext={() =>
                        advancedState.document
                        && selectWord(nextSyncWordCursor(advancedState.document, advancedState.cursor, 1))}
                    onPreviewWord={previewSelectedWord}
                    onPreviewLine={previewSelectedLine}
                    onDeleteTime={() => advancedDispatch({ type: AdvancedActionType.deleteTime, payload: undefined })}
                />
            )}
            <section
                className="synchronizer-workspace"
                onWheel={timingMode === "word" ? preserveWordQueueScroll : undefined}
                onTouchStart={timingMode === "word" ? preserveWordQueueScroll : undefined}
                onPointerDown={timingMode === "word" ? preserveWordQueueScroll : undefined}
            >
                <ul
                    ref={ul}
                    className={ulClassName}
                    onClickCapture={onLineClick}
                    onDoubleClickCapture={onLineDoubleClick}
                >
                    {state.lyric.map(LyricLineIter)}
                </ul>
                <AsidePanel
                    syncMode={syncMode}
                    setSyncMode={setSyncMode}
                    lrcState={state}
                    lrcDispatch={dispatch}
                    prefState={prefState}
                />
            </section>
            {prefState.screenButton && timingMode === "line" && prefState.lineCaptureMode === "standard" && (
                <SpaceButton
                    sync={sync}
                    disabled={!mediaReady}
                    label={lang.keybindings.actions.sync}
                    shortcutLabel={syncShortcutLabel}
                />
            )}
        </section>
    );
};

interface ILyricLineProps {
    line: ILyric;
    index: number;
    select: boolean;
    showLiveTime: boolean;
    highlight: boolean;
    className: string;
    prefState: PrefState;
    issueLabel?: string;
    timingPending: boolean;
    advancedLine?: AdvancedLyricLine;
    wordIssues?: readonly (WordTimingIssue | null)[];
    selectedWord?: number;
    playbackWords: readonly number[];
    language: Language["advancedLyrics"];
}

const LyricLine: React.FC<ILyricLineProps> = memo(({
    line,
    index,
    select,
    showLiveTime,
    highlight,
    className,
    prefState,
    issueLabel,
    timingPending,
    advancedLine,
    wordIssues,
    selectedWord,
    playbackWords,
    language,
}) => {
    const lineTime = line.time === undefined ? "—" : formatTimeTag(line.time, prefState.fixed, false);

    const lineText = formatText(line.text, prefState.spaceStart, prefState.spaceEnd);

    return (
        <li
            key={index}
            data-key={index}
            className={className}
            title={issueLabel}
            aria-invalid={issueLabel && !timingPending ? "true" : undefined}
            aria-current={highlight ? "true" : undefined}
        >
            <span className="line-index">{index + 1}</span>
            {select && showLiveTime && (
                <span className="line-live-time" aria-label={language.currentPlayback}>
                    <Curser fixed={prefState.fixed} />
                </span>
            )}
            {select && line.time === undefined && !showLiveTime
                ? <Curser fixed={prefState.fixed} />
                : line.time === undefined
                ? <time className="line-time">{lineTime}</time>
                : (
                    <button
                        type="button"
                        className="line-time line-time-play"
                        title={language.playFromLine}
                        aria-label={`${language.playFromLine}: ${lineTime}`}
                    >
                        {lineTime}
                    </button>
                )}
            <span className="line-text">
                <span className={`line-copy${advancedLine ? " word-timed-line" : ""}`}>
                    {advancedLine
                        ? (
                            <>
                                <span className="word-line-measure" aria-hidden="true">{lineText}</span>
                                <span className="word-line-content">
                                    {advancedLine.words.map((word, wordIndex) => {
                                        const wordIssue = wordIssues?.[wordIndex] || null;
                                        return (
                                            <span
                                                key={wordIndex}
                                                data-line={index}
                                                data-word={wordIndex}
                                                className={`timed-word${
                                                    selectedWord === wordIndex ? " selected-word" : ""
                                                }${playbackWords.includes(wordIndex) ? " playback-word" : ""}${
                                                    wordIssue ? ` word-error word-error-${wordIssue}` : ""
                                                }`}
                                                title={wordIssue ? wordIssueLabel(wordIssue, language) : undefined}
                                            >
                                                {word.text}
                                            </span>
                                        );
                                    })}
                                </span>
                            </>
                        )
                        : lineText}
                </span>
                {(select || highlight || advancedLine) && (
                    <span
                        className="line-state-badges"
                        aria-label={[select && language.selectedLine, highlight && language.playingLine].filter(Boolean)
                            .join(", ")}
                    >
                        {select && <span className="selected-line-badge">{language.selectedLine}</span>}
                        {highlight && (
                            <span className="playing-line-badge">
                                <i aria-hidden="true" />
                                {language.playingLine}
                            </span>
                        )}
                    </span>
                )}
            </span>
            {issueLabel && (
                <span className="line-warning" role="img" aria-label={issueLabel}>
                    <ProblemSVG />
                </span>
            )}
        </li>
    );
}, (prev, next) =>
    prev.line === next.line
    && prev.index === next.index
    && prev.select === next.select
    && prev.showLiveTime === next.showLiveTime
    && prev.highlight === next.highlight
    && prev.className === next.className
    && prev.prefState === next.prefState
    && prev.issueLabel === next.issueLabel
    && prev.timingPending === next.timingPending
    && prev.advancedLine === next.advancedLine
    && prev.wordIssues === next.wordIssues
    && prev.selectedWord === next.selectedWord
    && prev.language === next.language
    && numberArraysEqual(prev.playbackWords, next.playbackWords));

LyricLine.displayName = "LyricLine";

const numberArraysEqual = (left: readonly number[], right: readonly number[]): boolean =>
    left === right || (left.length === right.length && left.every((value, index) => value === right[index]));

const cursorsEqual = (left: WordCursor | null, right: WordCursor | null): boolean =>
    left?.lineIndex === right?.lineIndex && left?.wordIndex === right?.wordIndex;

const nextUntimedWordCursor = (
    document: NonNullable<AdvancedLyricsState["document"]>,
    cursor: WordCursor,
): WordCursor => {
    const flattened: WordCursor[] = document.lines.flatMap((line, lineIndex) =>
        line.words.map((_, wordIndex) => ({ lineIndex, wordIndex }))
    );
    if (flattened.length === 0) return cursor;
    const currentIndex = flattened.findIndex((candidate) =>
        candidate.lineIndex === cursor.lineIndex && candidate.wordIndex === cursor.wordIndex
    );
    for (let offset = 1; offset <= flattened.length; offset += 1) {
        const candidate = flattened[(Math.max(0, currentIndex) + offset) % flattened.length];
        const word = document.lines[candidate.lineIndex]?.words[candidate.wordIndex];
        if (word?.startMs === undefined) return candidate;
    }
    return cursor;
};

const wordIssueLabel = (issue: WordTimingIssue, language: Language["advancedLyrics"]): string => {
    if (issue === "invalid") return language.invalidWordTime;
    if (issue === "duplicate") return language.duplicateWordTime;
    return language.backwardsWordTime;
};
