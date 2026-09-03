import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from "react";
import type { TimingWaveformView } from "../hooks/usePref.js";
import { formatLrcTimestamp } from "../utils/advanced-lyrics.js";
import { Waveform, type WaveformHandle } from "./waveform.js";

interface TimingWaveformPanelProps {
    source: string;
    themeColor: string;
    timingUnit: "line" | "word";
    lineText: string;
    wordText: string;
    wordStartMs?: number;
    fixed: Fixed;
    view: TimingWaveformView;
    zoom: number;
    amplitude: number;
    language: Language["advancedLyrics"];
    onSeek: (timeSeconds: number) => void;
    onCapture: (timeSeconds: number) => void;
    onUnavailable: () => void;
    onViewChange: (view: TimingWaveformView) => void;
    onZoomChange: (zoom: number) => void;
    onAmplitudeChange: (amplitude: number) => void;
}

export const TimingWaveformPanel = forwardRef<WaveformHandle, TimingWaveformPanelProps>(({
    source,
    themeColor,
    timingUnit,
    lineText,
    wordText,
    wordStartMs,
    fixed,
    view,
    zoom,
    amplitude,
    language,
    onSeek,
    onCapture,
    onUnavailable,
    onViewChange,
    onZoomChange,
    onAmplitudeChange,
}, ref) => {
    const waveformRef = useRef<WaveformHandle>(null);
    const canvasRef = useRef<HTMLDivElement>(null);

    useImperativeHandle(ref, () => ({
        scrollPage: (direction) => waveformRef.current?.scrollPage(direction),
        centerAt: (timeSeconds) => waveformRef.current?.centerAt(timeSeconds),
        setZoom: (pixelsPerSecond) => waveformRef.current?.setZoom(pixelsPerSecond),
        setAmplitude: (value) => waveformRef.current?.setAmplitude(value),
    }), []);

    useEffect(() => {
        if (wordStartMs !== undefined) waveformRef.current?.centerAt(Math.max(0, wordStartMs / 1000 - 2));
    }, [wordStartMs]);

    const updateZoom = useCallback((nextZoom: number) => {
        const clamped = Math.max(24, Math.min(420, nextZoom));
        onZoomChange(clamped);
        waveformRef.current?.setZoom(clamped);
    }, [onZoomChange]);

    const updateAmplitude = useCallback((nextAmplitude: number) => {
        const clamped = Math.max(0.5, Math.min(4, nextAmplitude));
        onAmplitudeChange(clamped);
        waveformRef.current?.setAmplitude(clamped);
    }, [onAmplitudeChange]);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const onWheel = (event: WheelEvent): void => {
            event.preventDefault();
            updateZoom(zoom * Math.exp(-event.deltaY * 0.0025));
        };
        canvas.addEventListener("wheel", onWheel, { passive: false });
        return () => canvas.removeEventListener("wheel", onWheel);
    }, [updateZoom, zoom]);

    const lineMode = timingUnit === "line";
    const title = lineMode ? language.lineWaveformCaptureTitle : language.waveformCaptureTitle;
    const hint = lineMode ? language.lineWaveformCaptureHint : language.waveformCaptureHint;

    return (
        <section className="word-waveform-panel" aria-label={title}>
            <header>
                <div>
                    <span>{lineMode ? language.currentLine : language.activeLine}</span>
                    <strong>{lineText || language.untimed}</strong>
                </div>
                <div className="word-waveform-current">
                    <span>{lineMode ? language.currentLinePosition : language.currentWord}</span>
                    <strong>{wordText || language.spaceSegment}</strong>
                    <time>
                        {wordStartMs === undefined
                            ? language.untimed
                            : formatLrcTimestamp(wordStartMs, fixed).slice(1, -1)}
                    </time>
                </div>
            </header>
            <div className="word-waveform-view-controls">
                <div className="word-waveform-view-switch" role="group" aria-label={language.waveformView}>
                    <button
                        type="button"
                        className={view === "waveform" ? "active" : ""}
                        aria-pressed={view === "waveform"}
                        onClick={() => onViewChange("waveform")}
                    >
                        {language.waveformViewWave}
                    </button>
                    <button
                        type="button"
                        className={view === "spectrogram" ? "active" : ""}
                        aria-pressed={view === "spectrogram"}
                        onClick={() => onViewChange("spectrogram")}
                    >
                        {language.waveformViewSpectrum}
                    </button>
                </div>
                <span>{language.waveformWheelZoom}</span>
                <button type="button" onClick={() => updateZoom(84)}>
                    {language.waveformResetZoom} <output>{Math.round(zoom)} px/s</output>
                </button>
                <label>
                    <span>{language.waveformAmplitude}</span>
                    <input
                        type="range"
                        min={0.5}
                        max={4}
                        step={0.1}
                        value={amplitude}
                        onChange={(event) => updateAmplitude(Number(event.target.value))}
                    />
                    <output>×{amplitude.toFixed(1)}</output>
                </label>
            </div>
            <div ref={canvasRef} className="word-waveform-canvas">
                <Waveform
                    ref={waveformRef}
                    source={source}
                    themeColor={themeColor}
                    height={view === "spectrogram" ? 46 : 168}
                    spectrogramHeight={122}
                    minPxPerSec={zoom}
                    autoScroll={true}
                    pointMode={true}
                    normalize={false}
                    barHeight={amplitude}
                    visualization={view}
                    className="word-capture-waveform"
                    ariaLabel={hint}
                    onSeek={onSeek}
                    onPoint={onCapture}
                    onUnavailable={onUnavailable}
                />
                <span>{hint}</span>
            </div>
            <footer>
                <span>
                    <kbd>S</kbd>
                    {lineMode ? language.lineWaveformPlayHotkey : language.waveformPlayHotkey}
                </span>
                <span>
                    <kbd>F</kbd>
                    {language.waveformScrollHotkey}
                </span>
                <span>
                    <kbd>Shift+F</kbd>
                    {language.waveformScrollBackHotkey}
                </span>
                <span>
                    <kbd>G</kbd>
                    {lineMode ? language.lineWaveformCommitHotkey : language.waveformStampHotkey}
                </span>
            </footer>
        </section>
    );
});

TimingWaveformPanel.displayName = "TimingWaveformPanel";
