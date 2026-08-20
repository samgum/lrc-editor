import { useEffect, useMemo, useState } from "react";
import {
    AdvancedActionType,
    type AdvancedLyricsAction,
    type AdvancedLyricsState,
    type WordCursor,
} from "../hooks/useAdvancedLyrics.js";
import {
    formatLrcTimestamp,
    parseFlexibleTimestamp,
    type TimedWord,
    wordTimingIssueAt,
} from "../utils/advanced-lyrics.js";
import { ProblemSVG } from "./svg.js";

export const AdvancedLyricsEditor: React.FC<{
    state: AdvancedLyricsState;
    dispatch: (action: AdvancedLyricsAction) => void;
    fixed: Fixed;
    language: Language["advancedLyrics"];
}> = ({ state, dispatch, fixed, language }) => {
    const document = state.document;
    if (!document) return null;

    return (
        <section className="advanced-lyrics-editor">
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
                    </header>
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
                </article>
            ))}
        </section>
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
