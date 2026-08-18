import SSK from "#const/session_key.json" assert { type: "json" };
import STRINGS from "#const/strings.json" assert { type: "json" };
import { convertTimeToTag, formatText, type ILyric } from "@lrc-maker/lrc-parser";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { useKeyBindings } from "../hooks/useKeyBindings.js";
import type { IState } from "../hooks/useLrc.js";
import { type Action, ActionType, guard } from "../hooks/useLrc.js";
import { type State as PrefState } from "../hooks/usePref.js";
import { AudioActionType, audioRef, audioStatePubSub, currentTimePubSub } from "../utils/audiomodule.js";
import { centeredFollowOffset, followEndSpace } from "../utils/follow-scroll.js";
import { InputAction } from "../utils/input-action.js";
import { isKeyboardElement } from "../utils/is-keyboard-element.js";
import { formatKeyBinding, getMatchedAction } from "../utils/keybindings.js";
import { type TimingIssue, timingIssueAt } from "../utils/timing-issues.js";
import { appContext } from "./app.context.js";
import { AsidePanel } from "./asidepanel.js";
import { Curser } from "./curser.js";
import { ProblemSVG } from "./svg.js";

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
}

export const Synchronizer: React.FC<ISynchronizerProps> = ({ state, dispatch }) => {
    const self = useRef(Symbol(Synchronizer.name));

    const { selectIndex, currentIndex: highlightIndex, lyric } = state;

    const { lang, prefState } = useContext(appContext);
    const keyBindings = useKeyBindings();
    const [mediaReady, setMediaReady] = useState(Boolean(audioRef.duration));
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
    }, [followLayoutRevision, needScrollLine, syncMode]);

    useEffect(() => {
        return currentTimePubSub.sub(self.current, (time) => {
            dispatch({ type: ActionType.refresh, payload: time });
        });
    }, [dispatch]);

    useEffect(() =>
        audioStatePubSub.sub(self.current, (state) => {
            if (state.type === AudioActionType.getDuration) setMediaReady(state.payload > 0);
        }), []);

    const sync = useCallback(() => {
        if (!audioRef.duration) {
            return;
        }

        dispatch({
            type: ActionType.next,
            payload: audioRef.currentTime,
        });
    }, [dispatch]);

    const adjust = useCallback(
        (ev: KeyboardEvent | React.MouseEvent, offset: number, index: number) => {
            if (!audioRef.duration) {
                return;
            }

            const selectTime = lyric[index]?.time;

            if (selectTime === undefined) {
                return;
            }

            dispatch({
                type: ActionType.time,
                payload: audioRef.step(ev, offset, selectTime),
            });
        },
        [dispatch, lyric],
    );

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

    useEffect(() => {
        function onKeydown(ev: KeyboardEvent): void {
            if (isKeyboardElement(ev.target)) {
                return;
            }

            const ctrlOrMeta = ev.ctrlKey || ev.metaKey;
            if (ctrlOrMeta && ev.code === "KeyZ") {
                ev.preventDefault();
                dispatch({
                    type: ev.shiftKey ? ActionType.redo : ActionType.undo,
                    payload: undefined,
                });
                return;
            }
            if (ctrlOrMeta && ev.code === "KeyY") {
                ev.preventDefault();
                dispatch({ type: ActionType.redo, payload: undefined });
                return;
            }

            const action = getMatchedAction(ev, keyBindings);

            switch (action) {
                case InputAction.Sync:
                    ev.preventDefault();
                    if (ev.repeat) {
                        break;
                    }
                    sync();
                    break;
                case InputAction.DeleteTime:
                    ev.preventDefault();
                    dispatch({ type: ActionType.deleteTime, payload: undefined });
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
                    selectLine((index) => index - 1);
                    break;
                case InputAction.NextLine:
                    ev.preventDefault();
                    selectLine((index) => index + 1);
                    break;
                case InputAction.FirstLine:
                    ev.preventDefault();
                    selectLine(() => 0);
                    break;
                case InputAction.LastLine:
                    ev.preventDefault();
                    selectLine(() => Infinity);
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

        document.addEventListener("keydown", onKeydown);

        return (): void => {
            document.removeEventListener("keydown", onKeydown);
        };
    }, [adjust, dispatch, keyBindings, prefState.fineTuneMs, selectIndex, selectLine, sync]);

    const onLineClick = useCallback(
        (ev: React.MouseEvent<HTMLUListElement & HTMLLIElement>) => {
            ev.stopPropagation();

            const target = ev.target as HTMLElement;

            if (target.classList.contains("line")) {
                const lineKey = Number.parseInt(target.dataset.key!, 10) || 0;

                selectLine(() => lineKey);
            }
        },
        [selectLine],
    );

    const onLineDoubleClick = useCallback(
        (ev: React.MouseEvent<HTMLUListElement | HTMLLIElement>) => {
            ev.stopPropagation();

            if (!audioRef.duration) {
                return;
            }

            const target = ev.target as HTMLElement;

            if (target.classList.contains("line")) {
                const key = Number.parseInt(target.dataset.key!, 10);
                const time = lyric[key]?.time;
                if (time !== undefined) {
                    selectLine(() => key);
                    audioRef.currentTime = time;
                }
            }
        },
        [lyric, selectLine],
    );

    const LyricLineIter = useCallback(
        (line: Readonly<ILyric>, index: number, lines: readonly ILyric[]) => {
            const select = index === selectIndex;
            const highlight = index === highlightIndex;
            const issue = timingIssueAt(lines, index);
            const error = issue !== null;

            const className = Object.entries({
                line: true,
                select,
                highlight,
                error,
                [`error-${issue}`]: error,
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
                    prefState={prefState}
                    issue={issue}
                    issueLabel={issue ? lang.timing[issue] : undefined}
                />
            );
        },
        [lang.timing, selectIndex, highlightIndex, prefState],
    );

    const ulClassName = prefState.screenButton ? "lyric-list on-screen-button" : "lyric-list";
    const selectedTime = lyric[selectIndex]?.time;
    const selectedTimeLabel = selectedTime === undefined
        ? lang.timing.noTimestamp
        : convertTimeToTag(selectedTime, prefState.fixed).slice(1, -1);

    return (
        <section
            ref={page}
            className={`timing-page ${syncMode === SyncMode.highlight ? "follow-playback" : "follow-selection"}`}
        >
            <header className="timing-toolbar">
                <div className="timing-selection">
                    <span>{selectIndex + 1} / {lyric.length}</span>
                    <strong>{lyric[selectIndex]?.text || lang.timing.emptyLine}</strong>
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
                <div className="timing-actions">
                    <button
                        type="button"
                        onClick={() => dispatch({ type: ActionType.undo, payload: undefined })}
                        disabled={state.historyPast.length === 0}
                    >
                        {lang.timing.undo}
                    </button>
                    <button
                        type="button"
                        onClick={() => dispatch({ type: ActionType.redo, payload: undefined })}
                        disabled={state.historyFuture.length === 0}
                    >
                        {lang.timing.redo}
                    </button>
                    <button className="timing-capture" type="button" onClick={sync} disabled={!mediaReady}>
                        <span>{lang.keybindings.actions.sync}</span>
                        {syncShortcutLabel && <kbd>{syncShortcutLabel}</kbd>}
                    </button>
                </div>
            </header>
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
            {prefState.screenButton && <SpaceButton sync={sync} />}
        </section>
    );
};

interface ILyricLineProps {
    line: ILyric;
    index: number;
    select: boolean;
    className: string;
    prefState: PrefState;
    issue: TimingIssue | null;
    issueLabel?: string;
}

const LyricLine: React.FC<ILyricLineProps> = ({
    line,
    index,
    select,
    className,
    prefState,
    issue,
    issueLabel,
}) => {
    const lineTime = line.time === undefined ? "—" : convertTimeToTag(line.time, prefState.fixed).slice(1, -1);

    const lineText = formatText(line.text, prefState.spaceStart, prefState.spaceEnd);

    return (
        <li
            key={index}
            data-key={index}
            className={className}
            title={issueLabel}
            aria-invalid={issue ? "true" : undefined}
        >
            <span className="line-index">{index + 1}</span>
            {select && line.time === undefined
                ? <Curser fixed={prefState.fixed} />
                : <time className="line-time">{lineTime}</time>}
            <span className="line-text">{lineText}</span>
            {issue && (
                <span className="line-warning" role="img" aria-label={issueLabel}>
                    <ProblemSVG />
                </span>
            )}
        </li>
    );
};
