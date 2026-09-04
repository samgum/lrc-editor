import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { TimingWaveformView } from "../hooks/usePref.js";
import { formatLrcTimestamp } from "../utils/advanced-lyrics.js";
import { audioRef, currentTimePubSub } from "../utils/audiomodule.js";
import {
    type BeatGrid,
    beatGridLines,
    normalizeBeatGrid,
    readBeatGrid,
    saveBeatGrid,
    snapToBeatGrid,
} from "../utils/beat-grid.js";
import { timingPanelHeights } from "../utils/waveform-data.js";
import { BeatGridControls } from "./beat-grid-controls.js";
import { Waveform, type WaveformHandle, type WaveformViewport } from "./waveform.js";

interface TimingWaveformPanelProps {
    source: string;
    themeColor: string;
    timingUnit: "line" | "word";
    selectionKey: string;
    lineText: string;
    wordText: string;
    wordStartMs?: number;
    fixed: Fixed;
    view: TimingWaveformView;
    zoom: number;
    amplitude: number;
    heightPercent: number;
    lineAutoAdvance?: boolean;
    linePlayAfterSet?: boolean;
    language: Language["advancedLyrics"];
    onCapture: (timeSeconds: number) => void;
    onUnavailable: () => void;
    onViewChange: (view: TimingWaveformView) => void;
    onZoomChange: (zoom: number) => void;
    onAmplitudeChange: (amplitude: number) => void;
    onHeightChange: (height: number) => void;
}

export const TimingWaveformPanel = forwardRef<WaveformHandle, TimingWaveformPanelProps>(({
    source,
    themeColor,
    timingUnit,
    selectionKey,
    lineText,
    wordText,
    wordStartMs,
    fixed,
    view,
    zoom,
    amplitude,
    heightPercent,
    lineAutoAdvance = false,
    linePlayAfterSet = false,
    language,
    onCapture,
    onUnavailable,
    onViewChange,
    onZoomChange,
    onAmplitudeChange,
    onHeightChange,
}, ref) => {
    const waveformRef = useRef<WaveformHandle>(null);
    const canvasRef = useRef<HTMLDivElement>(null);
    const hoverGuideRef = useRef<HTMLSpanElement>(null);
    const hoverTooltipRef = useRef<HTMLOutputElement>(null);
    const captureMarkerRef = useRef<HTMLSpanElement>(null);
    const playheadRef = useRef<HTMLSpanElement>(null);
    const playheadTimeRef = useRef<HTMLTimeElement>(null);
    const renderPlayheadRef = useRef<(timeSeconds: number) => void>(() => undefined);
    const playbackSubscriberRef = useRef(Symbol("timing-waveform-playhead"));
    const latestPointerOffsetRef = useRef<number | null>(null);
    const pointerBypassRef = useRef(false);
    const zoomTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const zoomValueRef = useRef(zoom);
    const [displayZoom, setDisplayZoom] = useState(zoom);
    const [lastCaptureMs, setLastCaptureMs] = useState<number | null>(null);
    const [grid, setGrid] = useState(() => readBeatGrid(source));
    const [readyView, setReadyView] = useState<TimingWaveformView | null>(null);
    const plotReady = readyView === view;
    const [canvasHeight, setCanvasHeight] = useState(() =>
        Math.max(220, Math.min(660, window.innerHeight * heightPercent / 100))
    );
    const [viewport, setViewport] = useState<WaveformViewport>({
        start: 0,
        end: 0,
        width: 0,
        duration: 0,
        pixelsPerSecond: zoom,
    });
    const heights = timingPanelHeights(canvasHeight, view === "spectrogram");
    const gridLines = useMemo(
        () => beatGridLines(grid, viewport.start, viewport.end, viewport.pixelsPerSecond, viewport.duration),
        [grid, viewport],
    );
    const refreshPlayhead = useCallback((): void => {
        requestAnimationFrame(() => renderPlayheadRef.current(audioRef.currentTime));
    }, []);
    const onPlotReady = useCallback(() => {
        setReadyView(view);
        refreshPlayhead();
    }, [refreshPlayhead, view]);
    const onViewportChange = useCallback((next: WaveformViewport) => {
        setViewport((previous) =>
            previous.start === next.start && previous.width === next.width
                && previous.pixelsPerSecond === next.pixelsPerSecond
                && previous.duration === next.duration
                ? previous
                : next
        );
        refreshPlayhead();
    }, [refreshPlayhead]);
    const onGridChange = useCallback((next: BeatGrid) => {
        const normalized = normalizeBeatGrid(next);
        saveBeatGrid(source, normalized);
        setGrid(normalized);
        if (hoverGuideRef.current) hoverGuideRef.current.hidden = true;
        if (hoverTooltipRef.current) hoverTooltipRef.current.hidden = true;
    }, [source]);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const measure = (): void => setCanvasHeight(canvas.clientHeight);
        const observer = new ResizeObserver(() => {
            clearTimeout(timer);
            timer = setTimeout(measure, 140);
        });
        observer.observe(canvas);
        measure();
        return () => {
            observer.disconnect();
            clearTimeout(timer);
        };
    }, []);

    useImperativeHandle(ref, () => ({
        scrollPage: (direction) => {
            waveformRef.current?.scrollPage(direction);
            refreshPlayhead();
        },
        scrollBy: (pixels) => {
            waveformRef.current?.scrollBy(pixels);
            refreshPlayhead();
        },
        centerAt: (timeSeconds) => {
            waveformRef.current?.centerAt(timeSeconds);
            refreshPlayhead();
        },
        setZoom: (pixelsPerSecond) => {
            waveformRef.current?.setZoom(pixelsPerSecond);
            refreshPlayhead();
        },
        zoomAt: (pixelsPerSecond, offsetPixels) => {
            waveformRef.current?.zoomAt(pixelsPerSecond, offsetPixels);
            refreshPlayhead();
        },
        setAmplitude: (value) => waveformRef.current?.setAmplitude(value),
        timeAtOffset: (offsetPixels) => waveformRef.current?.timeAtOffset(offsetPixels) || 0,
        offsetAtTime: (timeSeconds) => waveformRef.current?.offsetAtTime(timeSeconds) ?? -1,
    }), []);

    useEffect(() => {
        if (captureMarkerRef.current) captureMarkerRef.current.hidden = true;
        if (wordStartMs !== undefined) {
            waveformRef.current?.centerAt(Math.max(0, wordStartMs / 1000));
            refreshPlayhead();
        }
    }, [selectionKey]);

    useEffect(() => {
        zoomValueRef.current = zoom;
        setDisplayZoom(zoom);
    }, [zoom]);

    useEffect(() => () => {
        if (zoomTimerRef.current !== null) clearTimeout(zoomTimerRef.current);
    }, []);

    const updateZoom = useCallback((nextZoom: number, anchorOffset?: number) => {
        const clamped = Math.max(24, Math.min(420, nextZoom));
        if (captureMarkerRef.current) captureMarkerRef.current.hidden = true;
        zoomValueRef.current = clamped;
        setDisplayZoom(clamped);
        if (zoomTimerRef.current !== null) clearTimeout(zoomTimerRef.current);
        zoomTimerRef.current = setTimeout(() => {
            const canvasWidth = canvasRef.current?.clientWidth || 0;
            waveformRef.current?.zoomAt(clamped, anchorOffset ?? canvasWidth / 2);
            onZoomChange(clamped);
            zoomTimerRef.current = null;
        }, 90);
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
            if (event.shiftKey) {
                const bounds = canvas.getBoundingClientRect();
                const zoomDelta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
                updateZoom(zoomValueRef.current * Math.exp(-zoomDelta * 0.0025), event.clientX - bounds.left);
                return;
            }
            const distance = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
            if (captureMarkerRef.current) captureMarkerRef.current.hidden = true;
            waveformRef.current?.scrollBy(distance);
            refreshPlayhead();
        };
        canvas.addEventListener("wheel", onWheel, { passive: false });
        return () => canvas.removeEventListener("wheel", onWheel);
    }, [updateZoom]);

    const formatTime = useCallback(
        (timeSeconds: number) => formatLrcTimestamp(Math.round(timeSeconds * 1000), fixed).slice(1, -1),
        [fixed],
    );

    useEffect(() => {
        renderPlayheadRef.current = (timeSeconds) => {
            const canvas = canvasRef.current;
            const playhead = playheadRef.current;
            if (!canvas || !playhead) return;
            const offset = waveformRef.current?.offsetAtTime(timeSeconds) ?? -1;
            const visible = offset >= 0 && offset <= canvas.clientWidth;
            playhead.hidden = !visible;
            if (!visible) return;
            playhead.style.left = `${offset}px`;
            if (playheadTimeRef.current) playheadTimeRef.current.textContent = formatTime(timeSeconds);
        };
        renderPlayheadRef.current(audioRef.currentTime);
        return currentTimePubSub.sub(playbackSubscriberRef.current, (timeSeconds) => {
            renderPlayheadRef.current(timeSeconds);
        });
    }, [formatTime]);

    const updatePointerPreview = useCallback((offset: number, bypass: boolean) => {
        const canvas = canvasRef.current;
        if (!canvas || !plotReady) return;
        const time = waveformRef.current?.timeAtOffset(offset) || 0;
        const resolved = snapToBeatGrid(time, grid, viewport.pixelsPerSecond, viewport.duration, bypass);
        const guideOffset = waveformRef.current?.offsetAtTime(resolved.time) ?? offset;
        if (hoverGuideRef.current) {
            hoverGuideRef.current.hidden = false;
            hoverGuideRef.current.style.left = `${guideOffset}px`;
            hoverGuideRef.current.classList.toggle("snapped", resolved.snapped);
        }
        if (hoverTooltipRef.current) {
            hoverTooltipRef.current.hidden = false;
            hoverTooltipRef.current.style.left = `${Math.max(54, Math.min(canvas.clientWidth - 54, offset))}px`;
            hoverTooltipRef.current.textContent = language.waveformSetAt.replace("%s", formatTime(resolved.time))
                + (resolved.snapped ? ` · ${language.beatSnapped}` : "");
        }
    }, [formatTime, grid, language.beatSnapped, language.waveformSetAt, plotReady, viewport]);

    useEffect(() => {
        const refresh = (): void => {
            const offset = latestPointerOffsetRef.current;
            if (offset !== null) updatePointerPreview(offset, pointerBypassRef.current);
        };
        const onAlt = (event: KeyboardEvent): void => {
            if (event.key !== "Alt") return;
            pointerBypassRef.current = event.altKey;
            refresh();
        };
        refresh();
        document.addEventListener("keydown", onAlt);
        document.addEventListener("keyup", onAlt);
        return () => {
            document.removeEventListener("keydown", onAlt);
            document.removeEventListener("keyup", onAlt);
        };
    }, [updatePointerPreview]);

    const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        const canvas = canvasRef.current;
        if (!canvas || !plotReady) return;
        const bounds = canvas.getBoundingClientRect();
        if (event.clientY - bounds.top >= canvas.clientHeight - 16) {
            latestPointerOffsetRef.current = null;
            if (hoverGuideRef.current) hoverGuideRef.current.hidden = true;
            if (hoverTooltipRef.current) hoverTooltipRef.current.hidden = true;
            return;
        }
        const offset = Math.max(0, Math.min(canvas.clientWidth, event.clientX - bounds.left - canvas.clientLeft));
        latestPointerOffsetRef.current = offset;
        pointerBypassRef.current = event.altKey;
        updatePointerPreview(offset, event.altKey);
    }, [plotReady, updatePointerPreview]);

    const onPointerLeave = useCallback(() => {
        latestPointerOffsetRef.current = null;
        if (hoverGuideRef.current) hoverGuideRef.current.hidden = true;
        if (hoverTooltipRef.current) hoverTooltipRef.current.hidden = true;
    }, []);

    const capture = useCallback((timeSeconds: number) => {
        const milliseconds = Math.max(0, Math.round(timeSeconds * 1000));
        setLastCaptureMs(milliseconds);
        const offset = waveformRef.current?.offsetAtTime(timeSeconds) ?? -1;
        if (captureMarkerRef.current && offset >= 0) {
            captureMarkerRef.current.hidden = false;
            captureMarkerRef.current.style.left = `${offset}px`;
        }
        onCapture(timeSeconds);
    }, [onCapture]);

    const captureAtPointer = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
        const canvas = canvasRef.current;
        if (!canvas || !plotReady) return;
        const bounds = canvas.getBoundingClientRect();
        if (event.clientY - bounds.top >= canvas.clientHeight - 16) return;
        const offset = Math.max(0, Math.min(canvas.clientWidth, event.clientX - bounds.left - canvas.clientLeft));
        latestPointerOffsetRef.current = offset;
        pointerBypassRef.current = event.altKey;
        updatePointerPreview(offset, event.altKey);
        const time = waveformRef.current?.timeAtOffset(offset) || 0;
        capture(snapToBeatGrid(time, grid, viewport.pixelsPerSecond, viewport.duration, event.altKey).time);
    }, [capture, grid, plotReady, updatePointerPreview, viewport]);

    const lineMode = timingUnit === "line";
    const title = lineMode ? language.lineWaveformCaptureTitle : language.waveformCaptureTitle;
    const hint = view === "spectrogram"
        ? lineMode ? language.lineSpectrumCaptureHint : language.spectrumCaptureHint
        : lineMode
        ? language.lineWaveformCaptureHint
        : language.waveformCaptureHint;

    return (
        <section className="word-waveform-panel" aria-label={title}>
            <header>
                <div>
                    <span>{lineMode ? language.currentLine : language.activeLine}</span>
                    <strong title={lineText}>{lineText || language.untimed}</strong>
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
            <div
                className="word-waveform-view-controls"
                onKeyDown={(event) => {
                    if (event.key === " " || event.key === "Enter") event.stopPropagation();
                }}
                onKeyUp={(event) => {
                    if (event.key === " " || event.key === "Enter") event.stopPropagation();
                }}
            >
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
                    {language.waveformResetZoom}
                </button>
                <label className="word-waveform-zoom">
                    <span>{language.waveformZoom}</span>
                    <input
                        type="range"
                        min={24}
                        max={420}
                        step={4}
                        value={displayZoom}
                        onInput={(event) => updateZoom(Number(event.currentTarget.value))}
                    />
                    <output>{Math.round(displayZoom)} px/s</output>
                </label>
                <label className="word-waveform-amplitude">
                    <span>{view === "spectrogram" ? language.waveformBrightness : language.waveformAmplitude}</span>
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
                <label className="word-waveform-height">
                    <span>{language.waveformHeight}</span>
                    <input
                        type="range"
                        min={24}
                        max={70}
                        step={2}
                        value={heightPercent}
                        onChange={(event) => onHeightChange(Number(event.currentTarget.value))}
                    />
                    <output>{Math.round(canvasHeight)} px</output>
                </label>
            </div>
            <BeatGridControls grid={grid} selectedStart={wordStartMs} language={language} onChange={onGridChange} />
            <div
                ref={canvasRef}
                className="word-waveform-canvas"
                style={{ height: `clamp(220px, ${heightPercent}svh, 660px)` }}
                aria-busy={!plotReady}
                onClick={captureAtPointer}
                onPointerMove={onPointerMove}
                onPointerLeave={onPointerLeave}
            >
                <Waveform
                    ref={waveformRef}
                    source={source}
                    themeColor={themeColor}
                    height={heights.wave}
                    spectrogramHeight={heights.spectrum}
                    minPxPerSec={zoom}
                    autoScroll={false}
                    pointMode={true}
                    normalize={false}
                    barHeight={amplitude}
                    visualization={view}
                    className="word-capture-waveform"
                    ariaLabel={hint}
                    onSeek={() => undefined}
                    onReady={onPlotReady}
                    onViewportChange={onViewportChange}
                    onUnavailable={onUnavailable}
                />
                {grid.enabled && (
                    <div className="word-beat-grid" aria-hidden="true">
                        {gridLines.map((line) => (
                            <i key={line.time} className={`word-beat-line ${line.kind}`} style={{ left: line.x }}>
                                {line.kind === "bar" && line.x > 44 && <span>{line.bar}</span>}
                            </i>
                        ))}
                    </div>
                )}
                <span ref={hoverGuideRef} className="word-waveform-hover-guide" hidden />
                <span ref={captureMarkerRef} className="word-waveform-capture-marker" hidden />
                <span ref={playheadRef} className="word-waveform-playhead" hidden>
                    <time ref={playheadTimeRef} />
                </span>
                <output ref={hoverTooltipRef} className="word-waveform-hover-time" hidden />
                <span className="word-waveform-hint">{hint}</span>
            </div>
            <div className="word-waveform-feedback">
                <span>
                    {lineMode
                        ? lineAutoAdvance
                            ? language.waveformClickAutoNext
                            : language.waveformClickKeepLine
                        : language.waveformClickAutoNextWord}
                </span>
                {lineMode && linePlayAfterSet && <span>{language.waveformPlayAfterSetActive}</span>}
                {lineMode && !linePlayAfterSet && <span>{language.waveformKeepPlaybackPosition}</span>}
                <output aria-live="polite">
                    {lastCaptureMs === null
                        ? ""
                        : language.waveformStartSet.replace("%s", formatTime(lastCaptureMs / 1000))}
                </output>
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
