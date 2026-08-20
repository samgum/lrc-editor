import SSK from "#const/session_key.json" assert { type: "json" };
import STRINGS from "#const/strings.json" assert { type: "json" };
import { convertTimeToTag, formatText, type ILyric } from "@lrc-maker/lrc-parser";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import {
    AdvancedActionType,
    type AdvancedLyricsAction,
    type AdvancedLyricsState,
    nextWordCursor,
    type WordCursor,
} from "../hooks/useAdvancedLyrics.js";
import { useKeyBindings } from "../hooks/useKeyBindings.js";
import type { IState } from "../hooks/useLrc.js";
import { type Action, ActionType, guard } from "../hooks/useLrc.js";
import { type State as PrefState } from "../hooks/usePref.js";
import {
    type AdvancedLyricLine,
    type LyricsWorkspaceMode,
    type WordTimingIssue,
    wordTimingIssueAt,
} from "../utils/advanced-lyrics.js";
import { AudioActionType, audioRef, audioStatePubSub, currentTimePubSub } from "../utils/audiomodule.js";
import { centeredFollowOffset, followEndSpace } from "../utils/follow-scroll.js";
import { InputAction } from "../utils/input-action.js";
import { isKeyboardElement } from "../utils/is-keyboard-element.js";
import { formatKeyBinding, getMatchedAction } from "../utils/keybindings.js";
import { timingIssueAt } from "../utils/timing-issues.js";
import { appContext } from "./app.context.js";
import { AsidePanel } from "./asidepanel.js";
import { Curser } from "./curser.js";
import { LyricsModeSwitch } from "./lyrics-mode-switch.js";
import { ProblemSVG } from "./svg.js";
import { WordTimingStage } from "./word-timing-stage.js";

const SpaceButton: React.FC<{ sync: () => void }> = ({ sync }) => {
    return (
        <button className="space-button" onClick={sync}>
            space
        </button>
    );
};

export const enum SyncMode {
    select,
    highlight,
}

interface ISynchronizerProps {
    state: IState;
    dispatch: React.Dispatch<Action>;
    advancedState: AdvancedLyricsState;
    advancedDispatch: (action: AdvancedLyricsAction) => void;
    timingMode: LyricsWorkspaceMode;
    onTimingModeChange: (mode: LyricsWorkspaceMode) => void;
}

export const Synchronizer: React.FC<ISynchronizerProps> = ({
    state,
    dispatch,
    advancedState,
    advancedDispatch,
    timingMode,
    onTimingModeChange,
}) => {
    const self = useRef(Symbol(Synchronizer.name));

    const { selectIndex, currentIndex: highlightIndex, lyric } = state;

    const { lang, prefState, prefDispatch } = useContext(appContext);
    const keyBindings = useKeyBindings();
    const [mediaReady, setMediaReady] = useState(Boolean(audioRef.duration));
    const [playbackWord, setPlaybackWord] = useState<WordCursor | null>(null);
    const [playbackRate, setPlaybackRate] = useState(audioRef.playbackRate);
    const [isHoldingWord, setIsHoldingWord] = useState(false);
    const previewEndRef = useRef<number | null>(null);
    const holdingWordRef = useRef(false);
    const heldSyncKeyRef = useRef<string | null>(null);
    const syncShortcut = keyBindings[InputAction.Sync][0];
    const syncShortcutLabel = syncShortcut ? formatKeyBinding(syncShortcut) : null;

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
        for (const element of [ul.current, toolbar, footer, aside]) {
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
    }, [followLayoutRevision, needScrollLine, syncMode, timingMode]);

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
        return currentTimePubSub.sub(self.current, (time) => {
            if (previewEndRef.current !== null && time * 1000 >= previewEndRef.current - 8) {
                audioRef.current?.pause();
                audioRef.currentTime = previewEndRef.current / 1000;
                previewEndRef.current = null;
            }
            dispatch({ type: ActionType.refresh, payload: time });
            if (timingMode === "word" && advancedState.document) {
                const next = wordAtTime(advancedState.document.lines, Math.round(time * 1000));
                setPlaybackWord((current) => cursorsEqual(current, next) ? current : next);
            }
        });
    }, [advancedState.document, dispatch, timingMode]);

    useEffect(() =>
        audioStatePubSub.sub(self.current, (state) => {
            if (state.type === AudioActionType.getDuration) setMediaReady(state.payload > 0);
            if (state.type === AudioActionType.rateChange) setPlaybackRate(state.payload);
        }), []);

    const captureTimeMs = useCallback(
        () => Math.max(0, Math.round(audioRef.currentTime * 1000 + prefState.wordTimingCompensationMs)),
        [
            prefState.wordTimingCompensationMs,
        ],
    );

    const sync = useCallback(() => {
        if (!audioRef.duration) {
            return;
        }

        if (timingMode === "word" && advancedState.document) {
            const next = nextWordCursor(advancedState.document, advancedState.cursor, 1);
            advancedDispatch({ type: AdvancedActionType.stamp, payload: captureTimeMs() });
            if (next.lineIndex !== state.selectIndex) {
                dispatch({ type: ActionType.select, payload: () => next.lineIndex });
            }
            return;
        }

        dispatch({
            type: ActionType.next,
            payload: audioRef.currentTime,
        });
    }, [
        advancedDispatch,
        advancedState.cursor,
        advancedState.document,
        captureTimeMs,
        dispatch,
        state.selectIndex,
        timingMode,
    ]);

    const startWordHold = useCallback(() => {
        if (!audioRef.duration || timingMode !== "word" || !advancedState.document || holdingWordRef.current) return;
        holdingWordRef.current = true;
        setIsHoldingWord(true);
        advancedDispatch({ type: AdvancedActionType.startHold, payload: captureTimeMs() });
    }, [advancedDispatch, advancedState.document, captureTimeMs, timingMode]);

    const finishWordHold = useCallback(() => {
        if (!holdingWordRef.current || timingMode !== "word" || !advancedState.document) return;
        holdingWordRef.current = false;
        setIsHoldingWord(false);
        const next = nextWordCursor(advancedState.document, advancedState.cursor, 1);
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
        state.selectIndex,
        timingMode,
    ]);

    const adjust = useCallback(
        (ev: KeyboardEvent | React.MouseEvent, offset: number, index: number) => {
            if (!audioRef.duration) {
                return;
            }

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

            const nextTime = audioRef.step(ev, offset, selectTime);
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

    const selectWord = useCallback((cursor: WordCursor) => {
        const document = advancedState.document;
        if (!document) return;
        const next = {
            lineIndex: guard(cursor.lineIndex, 0, document.lines.length - 1),
            wordIndex: guard(
                cursor.wordIndex,
                0,
                Math.max(0, document.lines[guard(cursor.lineIndex, 0, document.lines.length - 1)].words.length - 1),
            ),
        };
        advancedDispatch({ type: AdvancedActionType.select, payload: next });
        dispatch({ type: ActionType.select, payload: () => next.lineIndex });
        const time = document.lines[next.lineIndex].words[next.wordIndex]?.startMs;
        if (prefState.interactiveSeek && time !== undefined) audioRef.currentTime = time / 1000;
    }, [advancedDispatch, advancedState.document, dispatch, prefState.interactiveSeek]);

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
        const lastWordEnd = [...line.words].reverse().find((word) => word.endMs !== undefined)?.endMs;
        const fallbackEnd = line.startMs === undefined
            ? undefined
            : Math.min(audioRef.duration * 1000, line.startMs + 4000);
        const previewStart = line.startMs === undefined
            ? undefined
            : Math.max(0, line.startMs - prefState.wordPreviewLeadMs);
        previewRange(previewStart, line.endMs ?? nextLineStart ?? lastWordEnd ?? fallbackEnd);
    }, [advancedState.cursor.lineIndex, advancedState.document, prefState.wordPreviewLeadMs, previewRange]);

    useEffect(() => {
        function onKeydown(ev: KeyboardEvent): void {
            if (isKeyboardElement(ev.target)) {
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

            const action = getMatchedAction(ev, keyBindings);

            switch (action) {
                case InputAction.Sync:
                    ev.preventDefault();
                    if (ev.repeat) {
                        break;
                    }
                    if (timingMode === "word" && prefState.wordHoldMode) {
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
                        selectWord(nextWordCursor(advancedState.document, advancedState.cursor, -1));
                    } else selectLine((index) => index - 1);
                    break;
                case InputAction.NextLine:
                    ev.preventDefault();
                    if (timingMode === "word" && advancedState.document) {
                        selectWord(nextWordCursor(advancedState.document, advancedState.cursor, 1));
                    } else selectLine((index) => index + 1);
                    break;
                case InputAction.FirstLine:
                    ev.preventDefault();
                    if (timingMode === "word") selectWord({ lineIndex: 0, wordIndex: 0 });
                    else selectLine(() => 0);
                    break;
                case InputAction.LastLine:
                    ev.preventDefault();
                    if (timingMode === "word" && advancedState.document) {
                        const lineIndex = advancedState.document.lines.length - 1;
                        selectWord({
                            lineIndex,
                            wordIndex: Math.max(0, advancedState.document.lines[lineIndex].words.length - 1),
                        });
                    } else selectLine(() => Infinity);
                    break;
                case InputAction.PageUp:
                    ev.preventDefault();
                    selectLine((index) => index - 10);
                    break;
                case InputAction.PageDown:
                    ev.preventDefault();
                    selectLine((index) => index + 10);
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
            heldSyncKeyRef.current = null;
            if (holdingWordRef.current) finishWordHold();
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
        dispatch,
        keyBindings,
        prefState.fineTuneMs,
        prefState.wordHoldMode,
        selectIndex,
        selectLine,
        selectWord,
        sync,
        startWordHold,
        finishWordHold,
        timingMode,
    ]);

    const onLineClick = useCallback(
        (ev: React.MouseEvent<HTMLUListElement & HTMLLIElement>) => {
            ev.stopPropagation();

            const target = ev.target as HTMLElement;

            const wordTarget = target.closest<HTMLElement>(".timed-word");
            if (timingMode === "word" && wordTarget) {
                selectWord({
                    lineIndex: Number.parseInt(wordTarget.dataset.line!, 10),
                    wordIndex: Number.parseInt(wordTarget.dataset.word!, 10),
                });
                return;
            }

            if (target.classList.contains("line")) {
                const lineKey = Number.parseInt(target.dataset.key!, 10) || 0;

                selectLine(() => lineKey);
            }
        },
        [selectLine, selectWord, timingMode],
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
                    selectWord(cursor);
                    audioRef.currentTime = time / 1000;
                }
                return;
            }

            if (target.classList.contains("line")) {
                const key = Number.parseInt(target.dataset.key!, 10);
                const time = lyric[key]?.time;
                if (time !== undefined) {
                    selectLine(() => key);
                    audioRef.currentTime = time;
                }
            }
        },
        [advancedState.document, lyric, selectLine, selectWord, timingMode],
    );

    const LyricLineIter = useCallback(
        (line: Readonly<ILyric>, index: number, lines: readonly ILyric[]) => {
            const select = index === selectIndex;
            const highlight = index === highlightIndex;
            const issue = timingIssueAt(lines, index);
            const wordIssue = timingMode === "word" && advancedState.document
                ? firstWordIssue(advancedState.document, index)
                : null;
            const error = issue !== null || wordIssue !== null;
            const issueLabel = issue
                ? lang.timing[issue]
                : wordIssue
                ? wordIssueLabel(wordIssue.issue, lang.advancedLyrics)
                : undefined;

            const className = Object.entries({
                line: true,
                select,
                highlight,
                error,
                [`error-${issue}`]: issue !== null,
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
                    highlight={highlight}
                    prefState={prefState}
                    issueLabel={issueLabel}
                    advancedLine={timingMode === "word" ? advancedState.document?.lines[index] : undefined}
                    wordIssues={timingMode === "word" && advancedState.document
                        ? advancedState.document.lines[index].words.map((_, wordIndex) =>
                            wordTimingIssueAt(advancedState.document!, index, wordIndex)
                        )
                        : undefined}
                    selectedWord={advancedState.cursor.lineIndex === index ? advancedState.cursor.wordIndex : undefined}
                    playbackWord={playbackWord?.lineIndex === index ? playbackWord.wordIndex : undefined}
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
            playbackWord,
            prefState,
            selectIndex,
            timingMode,
        ],
    );

    const ulClassName = prefState.screenButton ? "lyric-list on-screen-button" : "lyric-list";
    const selectedWord = timingMode === "word"
        ? advancedState.document?.lines[advancedState.cursor.lineIndex]?.words[advancedState.cursor.wordIndex]
        : undefined;
    const selectedTime = timingMode === "word"
        ? selectedWord?.startMs === undefined ? undefined : selectedWord.startMs / 1000
        : lyric[selectIndex]?.time;
    const selectedTimeLabel = selectedTime === undefined
        ? lang.timing.noTimestamp
        : convertTimeToTag(selectedTime, prefState.fixed).slice(1, -1);

    return (
        <section
            ref={page}
            className={`timing-page ${syncMode === SyncMode.highlight ? "follow-playback" : "follow-selection"}${
                timingMode === "word" ? " word-mode" : ""
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
                                    advancedState.document.lines[advancedState.cursor.lineIndex].words.length
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
                            disabled={!mediaReady || selectedTime === undefined}
                        >
                            −{prefState.fineTuneMs} ms
                        </button>
                        <time>{selectedTimeLabel}</time>
                        <button
                            type="button"
                            title={lang.keybindings.actions.increaseOffset}
                            aria-label={`${lang.keybindings.actions.increaseOffset}: ${prefState.fineTuneMs} ms`}
                            onClick={(event) => adjust(event, prefState.fineTuneMs / 1000, selectIndex)}
                            disabled={!mediaReady || selectedTime === undefined}
                        >
                            +{prefState.fineTuneMs} ms
                        </button>
                    </div>
                </div>
                {prefState.advancedLyricsEnabled && (
                    <LyricsModeSwitch
                        className="timing-mode-switch"
                        mode={timingMode}
                        onChange={(mode) => {
                            if (holdingWordRef.current) finishWordHold();
                            onTimingModeChange(mode);
                        }}
                        labels={lang.advancedLyrics}
                    />
                )}
                <div className="timing-actions">
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
                    {timingMode === "line" && (
                        <button className="timing-capture" type="button" onClick={sync} disabled={!mediaReady}>
                            <span>{lang.keybindings.actions.sync}</span>
                            {syncShortcutLabel && <kbd>{syncShortcutLabel}</kbd>}
                        </button>
                    )}
                </div>
            </header>
            {timingMode === "word" && advancedState.document && (
                <WordTimingStage
                    document={advancedState.document}
                    cursor={advancedState.cursor}
                    playbackWord={playbackWord}
                    fixed={prefState.fixed}
                    mediaReady={mediaReady}
                    syncShortcutLabel={syncShortcutLabel}
                    holdMode={prefState.wordHoldMode}
                    isHolding={isHoldingWord}
                    compensationMs={prefState.wordTimingCompensationMs}
                    previewLeadMs={prefState.wordPreviewLeadMs}
                    playbackRate={playbackRate}
                    language={lang.advancedLyrics}
                    onSelectWord={selectWord}
                    onStamp={sync}
                    onHoldStart={startWordHold}
                    onHoldEnd={finishWordHold}
                    onCaptureModeChange={(holdMode) => {
                        if (holdingWordRef.current) finishWordHold();
                        prefDispatch({ type: "wordHoldMode", payload: holdMode });
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
                    onPrevious={() =>
                        advancedState.document
                        && selectWord(nextWordCursor(advancedState.document, advancedState.cursor, -1))}
                    onNext={() =>
                        advancedState.document
                        && selectWord(nextWordCursor(advancedState.document, advancedState.cursor, 1))}
                    onPreviewWord={previewSelectedWord}
                    onPreviewLine={previewSelectedLine}
                    onDeleteTime={() => advancedDispatch({ type: AdvancedActionType.deleteTime, payload: undefined })}
                />
            )}
            <section className="synchronizer-workspace">
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
                    lrcDispatch={dispatch}
                    prefState={prefState}
                />
            </section>
            {prefState.screenButton && timingMode === "line" && <SpaceButton sync={sync} />}
        </section>
    );
};

interface ILyricLineProps {
    line: ILyric;
    index: number;
    select: boolean;
    highlight: boolean;
    className: string;
    prefState: PrefState;
    issueLabel?: string;
    advancedLine?: AdvancedLyricLine;
    wordIssues?: readonly (WordTimingIssue | null)[];
    selectedWord?: number;
    playbackWord?: number;
    language: Language["advancedLyrics"];
}

const LyricLine: React.FC<ILyricLineProps> = ({
    line,
    index,
    select,
    highlight,
    className,
    prefState,
    issueLabel,
    advancedLine,
    wordIssues,
    selectedWord,
    playbackWord,
    language,
}) => {
    const lineTime = line.time === undefined ? "—" : convertTimeToTag(line.time, prefState.fixed).slice(1, -1);

    const lineText = formatText(line.text, prefState.spaceStart, prefState.spaceEnd);

    return (
        <li
            key={index}
            data-key={index}
            className={className}
            title={issueLabel}
            aria-invalid={issueLabel ? "true" : undefined}
            aria-current={highlight ? "true" : undefined}
        >
            <span className="line-index">{index + 1}</span>
            {select && line.time === undefined
                ? <Curser fixed={prefState.fixed} />
                : <time className="line-time">{lineTime}</time>}
            <span className="line-text">
                <span className={`line-copy${advancedLine ? " word-timed-line" : ""}`}>
                    {advancedLine
                        ? advancedLine.words.map((word, wordIndex) => {
                            const wordIssue = wordIssues?.[wordIndex] || null;
                            return (
                                <span
                                    key={wordIndex}
                                    data-line={index}
                                    data-word={wordIndex}
                                    className={`timed-word${selectedWord === wordIndex ? " selected-word" : ""}${
                                        playbackWord === wordIndex ? " playback-word" : ""
                                    }${wordIssue ? ` word-error word-error-${wordIssue}` : ""}`}
                                    title={wordIssue ? wordIssueLabel(wordIssue, language) : undefined}
                                >
                                    {word.text}
                                </span>
                            );
                        })
                        : lineText}
                </span>
                {(select || highlight) && (
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
};

const cursorsEqual = (left: WordCursor | null, right: WordCursor | null): boolean =>
    left?.lineIndex === right?.lineIndex && left?.wordIndex === right?.wordIndex;

const wordAtTime = (lines: readonly AdvancedLyricLine[], timeMs: number): WordCursor | null => {
    let result: WordCursor | null = null;
    let resultTime = -Infinity;
    for (const [lineIndex, line] of lines.entries()) {
        for (const [wordIndex, word] of line.words.entries()) {
            if (word.startMs !== undefined && word.startMs <= timeMs && word.startMs >= resultTime) {
                result = { lineIndex, wordIndex };
                resultTime = word.startMs;
            }
        }
    }
    return result;
};

const firstWordIssue = (
    document: NonNullable<AdvancedLyricsState["document"]>,
    lineIndex: number,
): { readonly wordIndex: number; readonly issue: WordTimingIssue } | null => {
    const words = document.lines[lineIndex]?.words || [];
    for (const [wordIndex] of words.entries()) {
        const issue = wordTimingIssueAt(document, lineIndex, wordIndex);
        if (issue) return { wordIndex, issue };
    }
    return null;
};

const wordIssueLabel = (issue: WordTimingIssue, language: Language["advancedLyrics"]): string => {
    if (issue === "invalid") return language.invalidWordTime;
    if (issue === "duplicate") return language.duplicateWordTime;
    return language.backwardsWordTime;
};
