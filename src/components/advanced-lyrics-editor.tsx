import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
    AdvancedActionType,
    type AdvancedLyricsAction,
    type AdvancedLyricsState,
    type WordCursor,
} from "../hooks/useAdvancedLyrics.js";
import {
    type AdvancedLyricLine,
    formatLrcTimestamp,
    lineText,
    parseFlexibleTimestamp,
    type TimedWord,
    wordTimingIssueAt,
} from "../utils/advanced-lyrics.js";
import { editWordTimedLine } from "../utils/word-text-edit.js";
import { ProblemSVG } from "./svg.js";

export const AdvancedLyricsEditor: React.FC<{
    state: AdvancedLyricsState;
    dispatch: (action: AdvancedLyricsAction) => void;
    fixed: Fixed;
    language: Language["advancedLyrics"];
    historyLabels: Pick<Language["timing"], "undo" | "redo">;
}> = ({ state, dispatch, fixed, language, historyLabels }) => {
    const [expandedLines, setExpandedLines] = useState<ReadonlySet<number>>(new Set());
    const document = state.document;
    if (!document) return null;

    return (
        <section className="advanced-lyrics-editor">
            <div className="advanced-editor-actions">
                <button
                    type="button"
                    disabled={!state.historyPast.length}
                    onClick={() => dispatch({ type: AdvancedActionType.undo, payload: undefined })}
                >
                    {historyLabels.undo}
                </button>
                <button
                    type="button"
                    disabled={!state.historyFuture.length}
                    onClick={() => dispatch({ type: AdvancedActionType.redo, payload: undefined })}
                >
                    {historyLabels.redo}
                </button>
                <button
                    type="button"
                    onClick={() => dispatch({ type: AdvancedActionType.addLine, payload: document.lines.length - 1 })}
                >
                    {language.addLine}
                </button>
            </div>
            {document.lines.map((line, lineIndex) => (
                <article className="advanced-edit-line" key={lineIndex}>
                    <header>
                        <strong>{lineIndex + 1}</strong>
                        <TimestampField
                            label={language.lineStart}
                            value={line.startMs}
                            fixed={fixed}
                            onCommit={(startMs) =>
                                dispatch({
                                    type: AdvancedActionType.updateLine,
                                    payload: { lineIndex, patch: { startMs } },
                                })}
                        />
                        <TimestampField
                            label={language.lineEnd}
                            value={line.endMs}
                            fixed={fixed}
                            onCommit={(endMs) =>
                                dispatch({
                                    type: AdvancedActionType.updateLine,
                                    payload: { lineIndex, patch: { endMs } },
                                })}
                        />
                        <div className="advanced-line-actions">
                            <button
                                type="button"
                                onClick={() => dispatch({ type: AdvancedActionType.addLine, payload: lineIndex })}
                            >
                                {language.addLine}
                            </button>
                            <button
                                type="button"
                                onClick={() => dispatch({ type: AdvancedActionType.removeLine, payload: lineIndex })}
                            >
                                {language.removeLine}
                            </button>
                        </div>
                    </header>
                    <SentenceEditor
                        line={line}
                        label={`${language.sentenceText} ${lineIndex + 1}`}
                        onSelect={() =>
                            dispatch({ type: AdvancedActionType.select, payload: { lineIndex, wordIndex: 0 } })}
                        onCommit={(patch) =>
                            dispatch({ type: AdvancedActionType.updateLine, payload: { lineIndex, patch } })}
                    />
                    <details
                        className="advanced-word-details"
                        onToggle={(event) => {
                            const open = event.currentTarget.open;
                            setExpandedLines((current) => {
                                const next = new Set(current);
                                if (open) next.add(lineIndex);
                                else next.delete(lineIndex);
                                return next;
                            });
                        }}
                    >
                        <summary>
                            {language.wordTimingDetails}{" "}
                            <span>
                                {line.words.filter((word) => word.startMs !== undefined).length} / {line.words.length}
                            </span>
                        </summary>
                        {expandedLines.has(lineIndex) && (
                            <div className="advanced-word-grid">
                                {line.words.map((word, wordIndex) => {
                                    const cursor = { lineIndex, wordIndex };
                                    return (
                                        <WordEditor
                                            key={`${lineIndex}-${wordIndex}`}
                                            word={word}
                                            cursor={cursor}
                                            selected={state.cursor.lineIndex === lineIndex
                                                && state.cursor.wordIndex === wordIndex}
                                            issue={wordTimingIssueAt(document, lineIndex, wordIndex)}
                                            fixed={fixed}
                                            language={language}
                                            dispatch={dispatch}
                                        />
                                    );
                                })}
                            </div>
                        )}
                    </details>
                </article>
            ))}
        </section>
    );
};

const SentenceEditor: React.FC<{
    line: AdvancedLyricLine;
    label: string;
    onSelect: () => void;
    onCommit: (line: AdvancedLyricLine) => void;
}> = ({ line, label, onSelect, onCommit }) => {
    const [text, setText] = useState(() => lineText(line));
    const input = useRef<HTMLTextAreaElement>(null);
    const draft = useRef(line);
    const original = useRef(line);
    const history = useRef(new Map([[lineText(line), line]]));
    const pending = useRef<{ start: number; end: number; type: string } | null>(null);
    const commitRef = useRef(onCommit);
    commitRef.current = onCommit;

    const commit = (): void => {
        if (lineText(draft.current) === lineText(original.current)) return;
        original.current = draft.current;
        commitRef.current(draft.current);
    };
    useEffect(() => {
        const ownCommit = line.words === draft.current.words && line.startMs === draft.current.startMs
            && line.endMs === draft.current.endMs;
        original.current = line;
        draft.current = line;
        if (!ownCommit) history.current = new Map([[lineText(line), line]]);
        else history.current.set(lineText(line), line);
        setText(lineText(line));
    }, [line]);
    useEffect(() => () => {
        if (lineText(draft.current) !== lineText(original.current)) commitRef.current(draft.current);
    }, []);
    useEffect(() => {
        const target = input.current!;
        const beforeInput = (event: InputEvent) => {
            pending.current = { start: target.selectionStart, end: target.selectionEnd, type: event.inputType };
        };
        target.addEventListener("beforeinput", beforeInput);
        return () => target.removeEventListener("beforeinput", beforeInput);
    }, []);
    const resize = (): void => {
        const target = input.current;
        if (!target) return;
        target.style.height = "0px";
        target.style.height = `${Math.max(54, target.scrollHeight + target.offsetHeight - target.clientHeight)}px`;
    };
    useLayoutEffect(resize, [text, label]);
    useEffect(() => {
        let width = 0;
        const observer = new ResizeObserver(([entry]) => {
            if (entry.contentRect.width === width) return;
            width = entry.contentRect.width;
            resize();
        });
        observer.observe(input.current!);
        return () => observer.disconnect();
    }, []);

    return (
        <textarea
            ref={input}
            className="advanced-sentence-text"
            rows={1}
            value={text}
            aria-label={label}
            spellCheck={false}
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect="off"
            onFocus={onSelect}
            onChange={(event) => {
                const next = event.currentTarget.value.replace(/\r?\n/g, " ");
                const change = pending.current;
                pending.current = null;
                const old = lineText(draft.current);
                if (change && change.start === change.end && change.type.startsWith("delete")) {
                    const removed = Math.max(0, old.length - next.length);
                    if (change.type.endsWith("Backward")) change.start = Math.max(0, change.end - removed);
                    else change.end = change.start + removed;
                }
                const restored = change && (change.type.startsWith("history") || change.type.includes("Composition"))
                    ? history.current.get(next)
                    : undefined;
                draft.current = next === lineText(original.current)
                    ? original.current
                    : restored ?? editWordTimedLine(draft.current, next, change ?? undefined);
                history.current.set(next, draft.current);
                if (history.current.size > 100) history.current.delete(history.current.keys().next().value!);
                setText(next);
            }}
            onBlur={commit}
            onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
                    event.preventDefault();
                    event.currentTarget.blur();
                }
            }}
        />
    );
};

const WordEditor: React.FC<{
    word: TimedWord;
    cursor: WordCursor;
    selected: boolean;
    issue: ReturnType<typeof wordTimingIssueAt>;
    fixed: Fixed;
    language: Language["advancedLyrics"];
    dispatch: (action: AdvancedLyricsAction) => void;
}> = ({ word, cursor, selected, issue, fixed, language, dispatch }) => {
    const [text, setText] = useState(word.text);
    useEffect(() => setText(word.text), [word.text]);

    const issueLabel = useMemo(() => {
        if (issue === "invalid") return language.invalidWordTime;
        if (issue === "duplicate") return language.duplicateWordTime;
        if (issue === "backwards") return language.backwardsWordTime;
        return undefined;
    }, [issue, language]);

    const select = () => dispatch({ type: AdvancedActionType.select, payload: cursor });
    const updateWord = (patch: Partial<TimedWord>) =>
        dispatch({ type: AdvancedActionType.updateWord, payload: { cursor, patch: { text, ...patch } } });

    return (
        <article
            className={`advanced-word-card${selected ? " selected" : ""}${issue ? ` issue issue-${issue}` : ""}`}
            title={issueLabel}
            aria-invalid={issue ? "true" : undefined}
            onFocus={select}
            onClick={select}
        >
            <div className="advanced-word-card-heading">
                <span>{cursor.wordIndex + 1}</span>
                {issue && (
                    <span className="advanced-word-warning" aria-label={issueLabel}>
                        <ProblemSVG />
                    </span>
                )}
            </div>
            <input
                className="advanced-word-text"
                value={text}
                aria-label={`${language.wordMode} ${cursor.wordIndex + 1}`}
                onChange={(event) => setText(event.target.value)}
                onBlur={() => {
                    if (text !== word.text) updateWord({ text });
                }}
                onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                }}
            />
            <TimestampField
                label={language.wordStart}
                value={word.startMs}
                fixed={fixed}
                onCommit={(startMs) => updateWord({ startMs })}
            />
            <TimestampField
                label={language.wordEnd}
                value={word.endMs}
                fixed={fixed}
                onCommit={(endMs) => updateWord({ endMs })}
            />
            <div className="advanced-word-actions">
                <button
                    type="button"
                    title={language.addSegment}
                    aria-label={language.addSegment}
                    onClick={(event) => {
                        event.stopPropagation();
                        dispatch({ type: AdvancedActionType.addWord, payload: cursor });
                    }}
                >
                    <span aria-hidden="true">+</span>
                </button>
                <button
                    type="button"
                    title={language.removeSegment}
                    aria-label={language.removeSegment}
                    onClick={(event) => {
                        event.stopPropagation();
                        dispatch({ type: AdvancedActionType.removeWord, payload: cursor });
                    }}
                >
                    <span aria-hidden="true">−</span>
                </button>
            </div>
        </article>
    );
};

const TimestampField: React.FC<{
    label: string;
    value?: number;
    fixed: Fixed;
    onCommit: (value: number | undefined) => void;
}> = ({ label, value, fixed, onCommit }) => {
    const formatted = value === undefined ? "" : formatLrcTimestamp(value, fixed).slice(1, -1);
    const [text, setText] = useState(formatted);
    useEffect(() => setText(formatted), [formatted]);

    const commit = () => {
        const parsed = parseFlexibleTimestamp(text);
        if (text.trim() && parsed === undefined) {
            setText(formatted);
            return;
        }
        if (parsed !== value) onCommit(parsed);
    };

    return (
        <label className="advanced-time-field">
            <span>{label}</span>
            <input
                inputMode="decimal"
                value={text}
                placeholder="—"
                onChange={(event) => setText(event.target.value)}
                onBlur={commit}
                onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                }}
            />
        </label>
    );
};
