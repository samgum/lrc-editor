import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { textTimingRows } from "../utils/text-timing-issues.js";
import { ArrowLeftSVG, ArrowRightSVG, ProblemSVG } from "./svg.js";

export const LyricTextEditor: React.FC<{
    text: string;
    inputRef: React.RefObject<HTMLTextAreaElement>;
    onBlur: React.FocusEventHandler<HTMLTextAreaElement>;
    language: Language;
}> = ({ text, inputRef, onBlur, language }) => {
    const normalizedText = text.replace(/\r\n?/g, "\n");
    const [draft, setDraft] = useState(normalizedText);
    const mirror = useRef<HTMLDivElement>(null);
    const rows = useMemo(() => textTimingRows(draft), [draft]);
    const issueIndexes = useMemo(() => rows.flatMap((row, index) => row.issue ? [index] : []), [rows]);

    const syncScroll = useCallback(() => {
        const input = inputRef.current;
        if (!input || !mirror.current) return;
        mirror.current.style.width = `${input.clientWidth}px`;
        mirror.current.style.transform = `translate(${-input.scrollLeft}px, ${-input.scrollTop}px)`;
    }, [inputRef]);

    useLayoutEffect(() => {
        if (inputRef.current && inputRef.current.value !== normalizedText) inputRef.current.value = normalizedText;
        setDraft(normalizedText);
        syncScroll();
    }, [inputRef, syncScroll, normalizedText]);

    useLayoutEffect(() => {
        const input = inputRef.current;
        if (!input) return;
        const observer = new ResizeObserver(syncScroll);
        observer.observe(input);
        syncScroll();
        return () => observer.disconnect();
    }, [inputRef, syncScroll]);

    useLayoutEffect(syncScroll, [draft, syncScroll]);

    const selectIssue = (index: number): void => {
        const input = inputRef.current;
        const row = rows[index];
        const line = mirror.current?.children[index] as HTMLElement | undefined;
        if (!input || !row || !line) return;
        input.focus({ preventScroll: true });
        input.setSelectionRange(row.start, row.end);
        input.scrollTop = Math.max(0, line.offsetTop - input.clientHeight * 0.3);
        syncScroll();
    };
    const nextIssue = (direction: -1 | 1): void => {
        const position = inputRef.current?.selectionStart ?? 0;
        const index = direction === 1
            ? issueIndexes.find((index) => rows[index].start > position) ?? issueIndexes[0]
            : [...issueIndexes].reverse().find((index) => rows[index].start < position) ?? issueIndexes.at(-1);
        if (index !== undefined) selectIssue(index);
    };

    return (
        <section className="lyric-text-workspace">
            {issueIndexes.length > 0 && (
                <div className="editor-issue-toolbar">
                    <span role="status" id="editor-timing-status">
                        {language.visual.timingIssues.replace("%d", String(issueIndexes.length))}
                    </span>
                    <button
                        type="button"
                        aria-label={language.visual.previousIssue}
                        title={language.visual.previousIssue}
                        onPointerDown={(event) => event.preventDefault()}
                        onClick={() => nextIssue(-1)}
                    >
                        <ArrowLeftSVG />
                    </button>
                    <button
                        type="button"
                        aria-label={language.visual.nextIssue}
                        title={language.visual.nextIssue}
                        onPointerDown={(event) => event.preventDefault()}
                        onClick={() => nextIssue(1)}
                    >
                        <ArrowRightSVG />
                    </button>
                </div>
            )}
            <div className="lyric-text-editor">
                <div className="lyric-text-mirror" ref={mirror}>
                    {rows.map((row, index) => (
                        <div className={`editor-text-row${row.issue ? " has-timing-issue" : ""}`} key={index}>
                            <span aria-hidden="true">{row.text || "\u200b"}</span>
                            {row.issue && (
                                <button
                                    type="button"
                                    className="editor-row-issue"
                                    tabIndex={-1}
                                    title={language.visual.lineIssue.replace("%line", String(index + 1))
                                        .replace("%issue", language.timing[row.issue])}
                                    aria-label={language.visual.lineIssue.replace("%line", String(index + 1))
                                        .replace("%issue", language.timing[row.issue])}
                                    onPointerDown={(event) => event.preventDefault()}
                                    onClick={() =>
                                        selectIssue(index)}
                                >
                                    <ProblemSVG />
                                </button>
                            )}
                        </div>
                    ))}
                </div>
                <textarea
                    ref={inputRef}
                    className="app-textarea"
                    defaultValue={text}
                    aria-label={language.visual.lyricEditor}
                    aria-invalid={issueIndexes.length > 0 || undefined}
                    aria-describedby={issueIndexes.length > 0 ? "editor-timing-status" : undefined}
                    onBlur={onBlur}
                    onScroll={syncScroll}
                    onChange={(event) => setDraft(event.currentTarget.value)}
                    autoCapitalize="none"
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck={false}
                />
            </div>
        </section>
    );
};
