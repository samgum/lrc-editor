import { useEffect, useMemo, useRef } from "react";
import type { WordCursor } from "../hooks/useAdvancedLyrics.js";
import {
    type AdvancedLyricsDocument,
    formatLrcTimestamp,
    lineText,
    wordTimingIssueAt,
} from "../utils/advanced-lyrics.js";
import { audioRef, currentTimePubSub } from "../utils/audiomodule.js";
import { ArrowLeftSVG, ArrowRightSVG, PlaySVG, Replay5sSVG } from "./svg.js";

interface WordTimingStageProps {
    document: AdvancedLyricsDocument;
    cursor: WordCursor;
    playbackWord: WordCursor | null;
    fixed: Fixed;
    mediaReady: boolean;
    syncShortcutLabel: string | null;
    holdMode: boolean;
    isHolding: boolean;
    compensationMs: number;
    previewLeadMs: number;
    playbackRate: number;
    language: Language["advancedLyrics"];
    onSelectWord: (cursor: WordCursor) => void;
    onStamp: () => void;
    onHoldStart: () => void;
    onHoldEnd: () => void;
    onCaptureModeChange: (holdMode: boolean) => void;
    onCompensationChange: (milliseconds: number) => void;
    onPreviewLeadChange: (milliseconds: number) => void;
    onPlaybackRateChange: (rate: number) => void;
    onSeek: (milliseconds: number) => void;
    onDistributeLine: (startMs: number, endMs: number) => void;
    onRestartFromWord: () => void;
    onPrevious: () => void;
    onNext: () => void;
    onPreviewWord: () => void;
    onPreviewLine: () => void;
    onDeleteTime: () => void;
}

export const WordTimingStage: React.FC<WordTimingStageProps> = ({
    document,
    cursor,
    playbackWord,
    fixed,
    mediaReady,
    syncShortcutLabel,
    holdMode,
    isHolding,
    compensationMs,
    previewLeadMs,
    playbackRate,
    language,
    onSelectWord,
    onStamp,
    onHoldStart,
    onHoldEnd,
    onCaptureModeChange,
    onCompensationChange,
    onPreviewLeadChange,
    onPlaybackRateChange,
    onSeek,
    onDistributeLine,
    onRestartFromWord,
    onPrevious,
    onNext,
    onPreviewWord,
    onPreviewLine,
    onDeleteTime,
}) => {
    const self = useRef(Symbol(WordTimingStage.name));
    const currentTimeRef = useRef<HTMLTimeElement>(null);
    const playheadRef = useRef<HTMLElement>(null);
    const line = document.lines[cursor.lineIndex];
    const word = line?.words[cursor.wordIndex];
    const previousLine = document.lines[cursor.lineIndex - 1];
    const nextLine = document.lines[cursor.lineIndex + 1];
    const lastWordEnd = line
        ? [...line.words].reverse().find((candidate) => candidate.endMs !== undefined)?.endMs
        : undefined;
    const lineStartMs = line?.startMs;
    const lineEndMs = line?.endMs ?? nextLine?.startMs ?? lastWordEnd;

    useEffect(() => {
        const update = (seconds: number) => {
            if (currentTimeRef.current) {
                currentTimeRef.current.textContent = formatLrcTimestamp(seconds * 1000, fixed).slice(1, -1);
            }
            if (
                playheadRef.current && lineStartMs !== undefined && lineEndMs !== undefined && lineEndMs > lineStartMs
            ) {
                const ratio = Math.max(0, Math.min(1, (seconds * 1000 - lineStartMs) / (lineEndMs - lineStartMs)));
                playheadRef.current.style.left = `${ratio * 100}%`;
            }
        };
        update(audioRef.currentTime);
        return currentTimePubSub.sub(self.current, update);
    }, [fixed, lineEndMs, lineStartMs]);

    const progress = useMemo(() => {
        let total = 0;
        let timed = 0;
        for (const candidateLine of document.lines) {
            for (const candidateWord of candidateLine.words) {
                if (!candidateWord.text) continue;
                total += 1;
                if (candidateWord.startMs !== undefined) timed += 1;
            }
        }
        return { total, timed };
    }, [document.lines]);

    const previousStampedTime = useMemo(() => {
        for (let lineIndex = cursor.lineIndex; lineIndex >= 0; lineIndex -= 1) {
            const words = document.lines[lineIndex]?.words || [];
            const start = lineIndex === cursor.lineIndex ? cursor.wordIndex - 1 : words.length - 1;
            for (let wordIndex = start; wordIndex >= 0; wordIndex -= 1) {
                if (words[wordIndex].startMs !== undefined) return words[wordIndex].startMs;
            }
        }
        return undefined;
    }, [cursor.lineIndex, cursor.wordIndex, document.lines]);

    if (!line || !word) return null;

    const displayWord = word.text.trim() || language.spaceSegment;
    const selectedStart = word.startMs === undefined
        ? language.untimed
        : formatLrcTimestamp(word.startMs, fixed).slice(1, -1);
    const selectedEnd = word.endMs === undefined
        ? language.openWordEnd
        : formatLrcTimestamp(word.endMs, fixed).slice(1, -1);

    return (
        <section className="word-timing-stage" aria-label={language.wordTimingWorkspace}>
            <header className="word-stage-summary">
                <div>
                    <span>{language.wordTimingWorkspace}</span>
                    <strong>{cursor.lineIndex + 1} / {document.lines.length}</strong>
                </div>
                <div className="word-stage-global-progress">
                    <span>{language.overallProgress}</span>
                    <strong>{progress.timed} / {progress.total}</strong>
                    <progress max={Math.max(1, progress.total)} value={progress.timed} />
                </div>
                <div className="word-stage-clock">
                    <span>{language.currentPlayback}</span>
                    <time ref={currentTimeRef}>00:00.000</time>
                </div>
                <div className="word-stage-clock last-stamped">
                    <span>{language.lastStamped}</span>
                    <time>
                        {previousStampedTime === undefined
                            ? "—"
                            : formatLrcTimestamp(previousStampedTime, fixed).slice(1, -1)}
                    </time>
                </div>
            </header>

            <div className="word-stage-rapid-controls">
                <div className="word-stage-mode" role="group" aria-label={language.captureMode}>
                    <span>{language.captureMode}</span>
                    <button
                        type="button"
                        className={holdMode ? "" : "active"}
                        aria-pressed={!holdMode}
                        onClick={() => onCaptureModeChange(false)}
                    >
                        {language.tapMode}
                    </button>
                    <button
                        type="button"
                        className={holdMode ? "active" : ""}
                        aria-pressed={holdMode}
                        onClick={() => onCaptureModeChange(true)}
                    >
                        {language.holdMode}
                    </button>
                </div>
                <label>
                    <span>{language.inputCompensation}</span>
                    <input
                        type="number"
                        min={-500}
                        max={500}
                        step={10}
                        value={compensationMs}
                        onChange={(event) => onCompensationChange(Number(event.target.value))}
                    />
                    <i>ms</i>
                </label>
                <label>
                    <span>{language.previewLead}</span>
                    <select
                        value={previewLeadMs}
                        onChange={(event) => onPreviewLeadChange(Number(event.target.value))}
                    >
                        {[0, 250, 500, 750, 1000, 1500, 2000].map((value) => (
                            <option key={value} value={value}>{value} ms</option>
                        ))}
                    </select>
                </label>
                <div className="word-stage-rate" role="group" aria-label={language.quickSpeed}>
                    <span>{language.quickSpeed}</span>
                    {[0.5, 0.75, 1, 1.25].map((rate) => (
                        <button
                            type="button"
                            key={rate}
                            disabled={!mediaReady}
                            className={Math.abs(playbackRate - rate) < 0.01 ? "active" : ""}
                            aria-pressed={Math.abs(playbackRate - rate) < 0.01}
                            onClick={() => onPlaybackRateChange(rate)}
                        >
                            {rate.toString()}×
                        </button>
                    ))}
                </div>
            </div>

            <div className="word-stage-carousel">
                <button
                    type="button"
                    className="word-stage-context previous"
                    disabled={!previousLine}
                    onClick={() => previousLine && onSelectWord({ lineIndex: cursor.lineIndex - 1, wordIndex: 0 })}
                >
                    <span>{language.previousLine}</span>
                    <strong>{previousLine ? lineText(previousLine) : "—"}</strong>
                </button>

                <div className="word-stage-active-line">
                    <span className="word-stage-line-label">{language.activeLine}</span>
                    <div className="word-stage-words">
                        {line.words.map((candidate, wordIndex) => {
                            const selected = wordIndex === cursor.wordIndex;
                            const playing = playbackWord?.lineIndex === cursor.lineIndex
                                && playbackWord.wordIndex === wordIndex;
                            const timed = candidate.startMs !== undefined;
                            const issue = wordTimingIssueAt(document, cursor.lineIndex, wordIndex);
                            return (
                                <button
                                    type="button"
                                    key={wordIndex}
                                    className={`word-stage-word${selected ? " selected" : ""}${
                                        playing ? " playing" : ""
                                    }${timed ? " timed" : " untimed"}${issue ? " issue" : ""}`}
                                    aria-pressed={selected}
                                    aria-current={playing ? "true" : undefined}
                                    onClick={() => onSelectWord({ lineIndex: cursor.lineIndex, wordIndex })}
                                >
                                    <span>{candidate.text.trim() || language.spaceSegment}</span>
                                    <time>
                                        {candidate.startMs === undefined
                                            ? "—"
                                            : formatLrcTimestamp(candidate.startMs, fixed).slice(1, -1)}
                                    </time>
                                </button>
                            );
                        })}
                    </div>
                </div>

                <button
                    type="button"
                    className="word-stage-context next"
                    disabled={!nextLine}
                    onClick={() => nextLine && onSelectWord({ lineIndex: cursor.lineIndex + 1, wordIndex: 0 })}
                >
                    <span>{language.nextLine}</span>
                    <strong>{nextLine ? lineText(nextLine) : "—"}</strong>
                </button>
            </div>

            {lineStartMs !== undefined && lineEndMs !== undefined && lineEndMs > lineStartMs && (
                <div className="word-stage-lane-wrap">
                    <span>{language.timingLane}</span>
                    <div
                        className="word-stage-lane"
                        role="slider"
                        aria-label={language.timingLane}
                        aria-valuemin={lineStartMs}
                        aria-valuemax={lineEndMs}
                        aria-valuenow={Math.round(audioRef.currentTime * 1000)}
                        onPointerDown={(event) => {
                            const bounds = event.currentTarget.getBoundingClientRect();
                            const ratio = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
                            onSeek(lineStartMs + ratio * (lineEndMs - lineStartMs));
                        }}
                    >
                        {line.words.map((candidate, wordIndex) => {
                            if (candidate.startMs === undefined) return null;
                            const candidateEnd = candidate.endMs
                                ?? line.words.slice(wordIndex + 1).find((item) => item.startMs !== undefined)?.startMs
                                ?? lineEndMs;
                            const left = (candidate.startMs - lineStartMs) / (lineEndMs - lineStartMs) * 100;
                            const width = Math.max(
                                0.35,
                                (candidateEnd - candidate.startMs) / (lineEndMs - lineStartMs) * 100,
                            );
                            return (
                                <i
                                    key={wordIndex}
                                    className={`${wordIndex === cursor.wordIndex ? "selected" : ""}${
                                        playbackWord?.lineIndex === cursor.lineIndex
                                            && playbackWord.wordIndex === wordIndex
                                            ? " playing"
                                            : ""
                                    }`}
                                    style={{ left: `${left}%`, width: `${width}%` }}
                                />
                            );
                        })}
                        <em ref={playheadRef} aria-hidden="true" />
                        <time className="start">{formatLrcTimestamp(lineStartMs, fixed).slice(1, -1)}</time>
                        <time className="end">{formatLrcTimestamp(lineEndMs, fixed).slice(1, -1)}</time>
                    </div>
                </div>
            )}

            <div className="word-stage-focus" aria-live="polite">
                <button
                    type="button"
                    className="word-stage-nav"
                    onClick={onPrevious}
                    aria-label={language.previousWord}
                >
                    <ArrowLeftSVG />
                </button>
                <div className="word-stage-current" key={`${cursor.lineIndex}-${cursor.wordIndex}`}>
                    <span>{language.currentWord}</span>
                    <strong>{displayWord}</strong>
                    <time>
                        {selectedStart}
                        <i>→</i>
                        {selectedEnd}
                    </time>
                </div>
                <button type="button" className="word-stage-nav" onClick={onNext} aria-label={language.nextWord}>
                    <ArrowRightSVG />
                </button>
            </div>

            <div className="word-stage-actions">
                <button
                    type="button"
                    className="word-stage-secondary"
                    disabled={word.startMs === undefined || !mediaReady}
                    onClick={onPreviewWord}
                >
                    <PlaySVG />
                    <span>{language.previewWord}</span>
                </button>
                <button
                    type="button"
                    className={`word-stage-capture${isHolding ? " holding" : ""}`}
                    disabled={!mediaReady}
                    onClick={() => !holdMode && onStamp()}
                    onPointerDown={(event) => {
                        if (!holdMode || !mediaReady) return;
                        event.preventDefault();
                        event.currentTarget.setPointerCapture(event.pointerId);
                        onHoldStart();
                    }}
                    onPointerUp={(event) => {
                        if (!holdMode) return;
                        event.preventDefault();
                        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                            event.currentTarget.releasePointerCapture(event.pointerId);
                        }
                        onHoldEnd();
                    }}
                    onPointerCancel={() => holdMode && onHoldEnd()}
                >
                    <span>
                        {holdMode ? (isHolding ? language.releaseWord : language.holdWord) : language.captureWord}
                    </span>
                    {syncShortcutLabel && <kbd>{syncShortcutLabel}</kbd>}
                </button>
                <button
                    type="button"
                    className="word-stage-secondary"
                    disabled={line.startMs === undefined || !mediaReady}
                    onClick={onPreviewLine}
                >
                    <Replay5sSVG />
                    <span>{language.replayLine}</span>
                </button>
                <button
                    type="button"
                    className="word-stage-delete"
                    disabled={word.startMs === undefined}
                    onClick={onDeleteTime}
                >
                    {language.deleteWordTime}
                </button>
            </div>
            <div className="word-stage-draft-actions">
                <button type="button" onClick={onRestartFromWord}>
                    {language.restartFromWord}
                </button>
                <button
                    type="button"
                    disabled={lineStartMs === undefined || lineEndMs === undefined || lineEndMs <= lineStartMs}
                    onClick={() =>
                        lineStartMs !== undefined
                        && lineEndMs !== undefined
                        && onDistributeLine(lineStartMs, lineEndMs)}
                >
                    {language.distributeLine}
                </button>
                <span>{language.draftTimingHint}</span>
            </div>
        </section>
    );
};
