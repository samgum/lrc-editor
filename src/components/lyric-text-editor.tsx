import ROUTER from "#const/router.json" assert { type: "json" };
import SSK from "#const/session_key.json" assert { type: "json" };
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { prependHash } from "../utils/router.js";
import { textTimingRows } from "../utils/text-timing-issues.js";
import { ArrowLeftSVG, ArrowRightSVG, ProblemSVG, UtilitySVG } from "./svg.js";

export const LyricTextEditor: React.FC<{
    text: string;
    inputRef: React.RefObject<HTMLTextAreaElement>;
    onBlur: React.FocusEventHandler<HTMLTextAreaElement>;
    onCommitText?: (value: string) => void;
    onDraftChange?: (value: string | null) => void;
    wordTiming?: boolean;
    language: Language;
}> = memo(({ text, inputRef, onBlur, onCommitText, onDraftChange, wordTiming = false, language }) => {
    const normalizedText = useMemo(() => text.replace(/\r\n?/g, "\n"), [text]);
    const [draft, setDraft] = useState(normalizedText);
    const [analysisText, setAnalysisText] = useState(normalizedText);
    const composingRef = useRef(false);
    const mirror = useRef<HTMLDivElement>(null);
    const scrollRafRef = useRef(0);
    const analysisTimerRef = useRef<number | undefined>(undefined);
    const committedRef = useRef(normalizedText);
    const draftRef = useRef(normalizedText);
    const onCommitRef = useRef(onCommitText);
    const onDraftChangeRef = useRef(onDraftChange);
    onCommitRef.current = onCommitText;
    onDraftChangeRef.current = onDraftChange;

    const analyzedRows = useMemo(() => textTimingRows(analysisText, wordTiming), [analysisText, wordTiming]);
    const issueIndexes = useMemo(
        () => analyzedRows.flatMap((row, index) => (row.issue ? [index] : [])),
        [analyzedRows],
    );
    const hasIssues = issueIndexes.length > 0;

    const rows = useMemo(() => {
        if (!hasIssues) return [];
        if (draft === analysisText) return analyzedRows;
        const rawLines = draft.split("\n");
        let offset = 0;
        return rawLines.map((line, index) => {
            const start = offset;
            const end = start + line.length;
            offset = end + 1;
            return {
                text: line,
                start,
                end,
                issue: rawLines.length === analyzedRows.length ? analyzedRows[index]?.issue ?? null : null,
            };
        });
    }, [analysisText, analyzedRows, draft, hasIssues]);

    const syncMirrorPosition = useCallback(() => {
        const input = inputRef.current;
        if (!input || !mirror.current) return;
        mirror.current.style.transform = `translate3d(${-input.scrollLeft}px, ${-input.scrollTop}px, 0)`;
    }, [inputRef]);

    const syncMirrorMetrics = useCallback(() => {
        const input = inputRef.current;
        if (!input || !mirror.current) return;
        mirror.current.style.width = `${input.clientWidth}px`;
        mirror.current.style.transform = `translate3d(${-input.scrollLeft}px, ${-input.scrollTop}px, 0)`;
    }, [inputRef]);

    const onScroll = useCallback(() => {
        if (!mirror.current) return;
        if (scrollRafRef.current) return;
        scrollRafRef.current = requestAnimationFrame(() => {
            scrollRafRef.current = 0;
            syncMirrorPosition();
        });
    }, [syncMirrorPosition]);

    useLayoutEffect(() => {
        window.clearTimeout(analysisTimerRef.current);
        if (inputRef.current && inputRef.current.value !== normalizedText) inputRef.current.value = normalizedText;
        composingRef.current = false;
        committedRef.current = normalizedText;
        draftRef.current = normalizedText;
        onDraftChangeRef.current?.(null);
        setDraft(normalizedText);
        setAnalysisText(normalizedText);
        syncMirrorMetrics();
    }, [inputRef, syncMirrorMetrics, normalizedText]);

    useEffect(() => {
        return () => {
            window.clearTimeout(analysisTimerRef.current);
            if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current);
            if (draftRef.current !== committedRef.current) {
                committedRef.current = draftRef.current;
                onDraftChangeRef.current?.(null);
                onCommitRef.current?.(draftRef.current);
            }
        };
    }, []);

    useLayoutEffect(() => {
        if (!hasIssues) return;
        const input = inputRef.current;
        if (!input) return;
        const observer = new ResizeObserver(syncMirrorMetrics);
        observer.observe(input);
        syncMirrorMetrics();
        return () => observer.disconnect();
    }, [hasIssues, inputRef, syncMirrorMetrics]);

    const selectIssue = (index: number): void => {
        const input = inputRef.current;
        const row = rows[index];
        const line = mirror.current?.children[index] as HTMLElement | undefined;
        if (!input || !row || !line) return;
        input.focus({ preventScroll: true });
        input.setSelectionRange(row.start, row.end);
        input.scrollTop = Math.max(0, line.offsetTop - input.clientHeight * 0.3);
        syncMirrorPosition();
    };
    const nextIssue = (direction: -1 | 1): void => {
        if (issueIndexes.length === 0) return;
        const position = inputRef.current?.selectionStart ?? 0;
        let index: number | undefined;
        if (direction === 1) {
            index = issueIndexes.find((candidate) => rows[candidate].start > position) ?? issueIndexes[0];
        } else {
            for (let i = issueIndexes.length - 1; i >= 0; i -= 1) {
                if (rows[issueIndexes[i]].start < position) {
                    index = issueIndexes[i];
                    break;
                }
            }
            index ??= issueIndexes[issueIndexes.length - 1];
        }
        if (index !== undefined) selectIssue(index);
    };

    return (
        <section className="lyric-text-workspace">
            {hasIssues && (
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
                    <a
                        className="editor-issue-fix-link"
                        href={prependHash(ROUTER.tools)}
                        onClick={() => {
                            if (draftRef.current !== committedRef.current) {
                                committedRef.current = draftRef.current;
                                onDraftChangeRef.current?.(null);
                                onCommitRef.current?.(draftRef.current);
                            }
                            sessionStorage.setItem(SSK.initialTool, "timeline-fix");
                        }}
                    >
                        <UtilitySVG />
                        <span>{language.editor.fixTimelineInTools}</span>
                    </a>
                </div>
            )}
            <div className="lyric-text-editor">
                {hasIssues && (
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
                )}
                <textarea
                    ref={inputRef}
                    className="app-textarea"
                    defaultValue={text}
                    aria-label={language.visual.lyricEditor}
                    aria-invalid={hasIssues || undefined}
                    aria-describedby={hasIssues ? "editor-timing-status" : undefined}
                    onBlur={(event) => {
                        window.clearTimeout(analysisTimerRef.current);
                        composingRef.current = false;
                        const next = event.currentTarget.value.replace(/\r\n?/g, "\n");
                        committedRef.current = next;
                        draftRef.current = next;
                        setDraft(next);
                        setAnalysisText(next);
                        onDraftChangeRef.current?.(null);
                        onBlur(event);
                    }}
                    onCompositionStart={() => {
                        composingRef.current = true;
                    }}
                    onCompositionEnd={(event) => {
                        composingRef.current = false;
                        const next = event.currentTarget.value.replace(/\r\n?/g, "\n");
                        draftRef.current = next;
                        setDraft(next);
                        setAnalysisText(next);
                    }}
                    onScroll={onScroll}
                    onChange={(event) => {
                        const next = event.currentTarget.value;
                        const normalizedNext = next.replace(/\r\n?/g, "\n");
                        draftRef.current = normalizedNext;
                        onDraftChangeRef.current?.(normalizedNext === committedRef.current ? null : next);
                        if (hasIssues) setDraft(normalizedNext);
                        if (!composingRef.current) {
                            window.clearTimeout(analysisTimerRef.current);
                            analysisTimerRef.current = window.setTimeout(() => {
                                setDraft(draftRef.current);
                                setAnalysisText(draftRef.current);
                            }, 160);
                        }
                    }}
                    autoCapitalize="none"
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck={false}
                />
            </div>
        </section>
    );
});

LyricTextEditor.displayName = "LyricTextEditor";
