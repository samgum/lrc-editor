import { useWavesurfer } from "@wavesurfer/react";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { audioRef } from "../utils/audiomodule";
import { clearOtherSpectrogramData } from "../utils/spectrogram-data.js";
import {
    cacheTimingPcm,
    clearOtherTimingPcm,
    readTimingPcm,
    timingSampleRate,
    waveformPixelsPerSecond,
} from "../utils/waveform-data.js";
import { SpectrogramCanvas } from "./spectrogram-canvas.js";
import "./waveform.css";

interface IWaveformProps {
    source: string;
    themeColor: string;
    /**
     * @param time seconds
     */
    onSeek: (time: number) => void;
    onUnavailable: () => void;
    onReady?: () => void;
    onViewportChange?: (viewport: WaveformViewport) => void;
    className?: string;
    height?: number;
    minPxPerSec?: number;
    autoScroll?: boolean;
    pointMode?: boolean;
    ariaLabel?: string;
    normalize?: boolean;
    barHeight?: number;
    visualization?: "waveform" | "spectrogram";
    spectrogramHeight?: number;
}

export interface WaveformViewport {
    start: number;
    end: number;
    width: number;
    duration: number;
    pixelsPerSecond: number;
}

export interface WaveformHandle {
    scrollPage: (direction: -1 | 1) => void;
    scrollBy: (pixels: number) => void;
    centerAt: (timeSeconds: number) => void;
    setZoom: (pixelsPerSecond: number) => void;
    zoomAt: (pixelsPerSecond: number, offsetPixels: number) => void;
    setAmplitude: (amplitude: number) => void;
    timeAtOffset: (offsetPixels: number) => number;
    offsetAtTime: (timeSeconds: number) => number;
}

interface CachedWaveformPeaks {
    duration: number;
    peaks: number[][];
}

const waveformPeakCache = new Map<string, CachedWaveformPeaks>();
const maximumCachedWaveforms = 2;

export const Waveform = forwardRef<WaveformHandle, IWaveformProps>(({
    source,
    themeColor,
    onSeek,
    onUnavailable,
    onReady,
    onViewportChange,
    className,
    height = 32,
    minPxPerSec,
    autoScroll = false,
    pointMode = false,
    ariaLabel = "waveform",
    normalize = true,
    barHeight = 1,
    visualization = "waveform",
    spectrogramHeight = height,
}, ref) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const [decodedAudio, setDecodedAudio] = useState<{ source: string; data: AudioBuffer } | null>(null);
    const [viewport, setViewport] = useState<WaveformViewport>({
        start: 0,
        end: 0,
        width: 0,
        duration: 0,
        pixelsPerSecond: 1,
    });
    const initialThemeColor = useRef(themeColor);
    const pixelsPerSecondRef = useRef(minPxPerSec || 0);
    const barHeightRef = useRef(barHeight);
    const heightRef = useRef(height);
    const creationOptionsRef = useRef({
        barHeight,
        height,
        minPxPerSec: minPxPerSec || 0,
    });
    const errorReportedRef = useRef(false);
    const pendingCenterTimeRef = useRef<number | null>(null);
    const cachedPeaksRef = useRef({ source, value: waveformPeakCache.get(source), pcm: readTimingPcm(source) });
    if (cachedPeaksRef.current.source !== source) {
        cachedPeaksRef.current = { source, value: waveformPeakCache.get(source), pcm: readTimingPcm(source) };
    }
    const cachedPeaks = cachedPeaksRef.current.value;
    const cachedPcm = cachedPeaksRef.current.pcm;
    const { wavesurfer } = useWavesurfer({
        container: containerRef,
        url: source,
        media: audioRef.current || undefined,
        waveColor: "#eeeeee",
        progressColor: initialThemeColor.current,
        cursorColor: initialThemeColor.current,
        normalize,
        barHeight: creationOptionsRef.current.barHeight,
        height: creationOptionsRef.current.height,
        barWidth: 2,
        barGap: 1,
        barRadius: 2,
        cursorWidth: 2,
        interact: !pointMode,
        dragToSeek: !pointMode,
        minPxPerSec: creationOptionsRef.current.minPxPerSec,
        autoScroll,
        autoCenter: autoScroll,
        sampleRate: pointMode ? timingSampleRate : 8_000,
        peaks: pointMode ? cachedPcm?.channels : cachedPeaks?.peaks,
        duration: pointMode ? cachedPcm?.duration : cachedPeaks?.duration,
    });

    const timeAtOffset = (offsetPixels: number): number => {
        if (!wavesurfer) return 0;
        const duration = wavesurfer.getDuration();
        const pixelsPerSecond = waveformPixelsPerSecond(pixelsPerSecondRef.current, wavesurfer.getWidth(), duration);
        return Math.max(0, Math.min(duration, (wavesurfer.getScroll() + offsetPixels) / pixelsPerSecond));
    };

    useImperativeHandle(ref, () => ({
        scrollPage: (direction) => {
            if (!wavesurfer) return;
            wavesurfer.setScroll(wavesurfer.getScroll() + direction * wavesurfer.getWidth() * 0.72);
        },
        scrollBy: (pixels) => {
            if (!wavesurfer) return;
            wavesurfer.setScroll(wavesurfer.getScroll() + pixels);
        },
        centerAt: (timeSeconds) => {
            pendingCenterTimeRef.current = timeSeconds;
            if (!wavesurfer) return;
            if (!wavesurfer.getDecodedData()) return;
            const pixelsPerSecond = waveformPixelsPerSecond(
                pixelsPerSecondRef.current,
                wavesurfer.getWidth(),
                wavesurfer.getDuration(),
            );
            wavesurfer.setScroll(Math.max(0, timeSeconds * pixelsPerSecond - wavesurfer.getWidth() / 2));
            pendingCenterTimeRef.current = null;
        },
        setZoom: (pixelsPerSecond) => {
            pixelsPerSecondRef.current = pixelsPerSecond;
            if (wavesurfer?.getDecodedData()) wavesurfer.zoom(pixelsPerSecond);
        },
        zoomAt: (pixelsPerSecond, offsetPixels) => {
            if (!wavesurfer?.getDecodedData()) return;
            const anchorTime = timeAtOffset(offsetPixels);
            pixelsPerSecondRef.current = pixelsPerSecond;
            wavesurfer.zoom(pixelsPerSecond);
            requestAnimationFrame(() => {
                wavesurfer.setScroll(Math.max(0, anchorTime * pixelsPerSecond - offsetPixels));
            });
        },
        setAmplitude: (amplitude) => {
            barHeightRef.current = amplitude;
            wavesurfer?.setOptions({ barHeight: amplitude });
        },
        timeAtOffset,
        offsetAtTime: (timeSeconds) => {
            if (!wavesurfer) return -1;
            const pixelsPerSecond = waveformPixelsPerSecond(
                pixelsPerSecondRef.current,
                wavesurfer.getWidth(),
                wavesurfer.getDuration(),
            );
            return timeSeconds * pixelsPerSecond - wavesurfer.getScroll();
        },
    }), [wavesurfer]);

    useEffect(() => {
        if (!wavesurfer) return;
        const applyCurrentDisplay = (): void => {
            wavesurfer.setOptions({
                barHeight: barHeightRef.current,
                height: heightRef.current,
                minPxPerSec: pixelsPerSecondRef.current,
            });
            const pendingCenterTime = pendingCenterTimeRef.current;
            if (pendingCenterTime !== null) {
                const pixelsPerSecond = waveformPixelsPerSecond(
                    pixelsPerSecondRef.current,
                    wavesurfer.getWidth(),
                    wavesurfer.getDuration(),
                );
                wavesurfer.setScroll(
                    Math.max(0, pendingCenterTime * pixelsPerSecond - wavesurfer.getWidth() / 2),
                );
                pendingCenterTimeRef.current = null;
            }
        };
        if (wavesurfer.getDecodedData()) {
            applyCurrentDisplay();
            return;
        }
        return wavesurfer.once("ready", applyCurrentDisplay);
    }, [wavesurfer]);

    useEffect(() => {
        const nextPixelsPerSecond = minPxPerSec || 0;
        if (pixelsPerSecondRef.current === nextPixelsPerSecond) return;
        pixelsPerSecondRef.current = nextPixelsPerSecond;
        if (wavesurfer?.getDecodedData()) wavesurfer.zoom(nextPixelsPerSecond);
    }, [minPxPerSec, wavesurfer]);

    useEffect(() => {
        if (barHeightRef.current === barHeight) return;
        barHeightRef.current = barHeight;
        wavesurfer?.setOptions({ barHeight });
    }, [barHeight, wavesurfer]);

    useEffect(() => {
        if (heightRef.current === height) return;
        heightRef.current = height;
        wavesurfer?.setOptions({ height });
    }, [height, wavesurfer]);

    useEffect(() => {
        errorReportedRef.current = false;
        clearOtherTimingPcm(source);
        clearOtherSpectrogramData(source);
    }, [source]);

    useEffect(() => {
        if (!wavesurfer) return;
        const ready = (): void => {
            const decoded = wavesurfer.getDecodedData();
            if (pointMode && decoded) {
                cacheTimingPcm(source, decoded);
                setDecodedAudio((previous) =>
                    previous?.source === source && previous.data === decoded ? previous : { source, data: decoded }
                );
            }
            if (!waveformPeakCache.has(source) && wavesurfer.getDecodedData()) {
                waveformPeakCache.set(source, {
                    duration: wavesurfer.getDuration(),
                    peaks: wavesurfer.exportPeaks({ channels: 2, maxLength: 8_000, precision: 10_000 }),
                });
                while (waveformPeakCache.size > maximumCachedWaveforms) {
                    const oldestSource = waveformPeakCache.keys().next().value;
                    if (oldestSource === undefined) break;
                    waveformPeakCache.delete(oldestSource);
                }
            }
            if (visualization === "waveform") onReady?.();
        };
        if (wavesurfer.getDecodedData()) ready();
        return wavesurfer.on("ready", ready);
    }, [onReady, pointMode, source, visualization, wavesurfer]);

    useEffect(() => {
        if (!wavesurfer || !pointMode && !onViewportChange) return;
        let frame = 0;
        const schedule = (): void => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => {
                const duration = wavesurfer.getDuration();
                const width = wavesurfer.getWidth();
                const pixelsPerSecond = waveformPixelsPerSecond(pixelsPerSecondRef.current, width, duration);
                const start = wavesurfer.getScroll() / pixelsPerSecond;
                const next = { start, end: start + width / pixelsPerSecond, width, duration, pixelsPerSecond };
                setViewport((previous) =>
                    previous.start === next.start && previous.width === next.width
                        && previous.duration === next.duration && previous.pixelsPerSecond === next.pixelsPerSecond
                        ? previous
                        : next
                );
                onViewportChange?.(next);
            });
        };
        const unsubscribe = [
            wavesurfer.on("scroll", schedule),
            wavesurfer.on("redraw", schedule),
            wavesurfer.on("ready", schedule),
        ];
        schedule();
        return () => {
            cancelAnimationFrame(frame);
            unsubscribe.forEach((stop) => stop());
        };
    }, [onViewportChange, pointMode, wavesurfer]);

    useEffect(() => {
        return wavesurfer?.on("interaction", (currentTime) => {
            onSeek(currentTime);
        });
    }, [wavesurfer, onSeek]);

    useEffect(() => {
        return wavesurfer?.on("error", () => {
            if (errorReportedRef.current) return;
            errorReportedRef.current = true;
            onUnavailable();
        });
    }, [onUnavailable, wavesurfer]);

    useEffect(() => {
        wavesurfer?.setOptions({
            waveColor: "#eeeeee",
            progressColor: themeColor,
            cursorColor: themeColor,
        });
    }, [themeColor, wavesurfer]);

    return (
        <div
            className={`waveform visualization-${visualization} ${pointMode ? "waveform-point" : ""} ${
                className || ""
            }`}
            aria-label={ariaLabel}
            style={visualization === "spectrogram" ? { filter: `brightness(${barHeight})` } : undefined}
        >
            <div className="waveform-renderer" ref={containerRef} />
            {visualization === "spectrogram" && (
                <SpectrogramCanvas
                    key={source}
                    source={source}
                    audio={decodedAudio?.source === source ? decodedAudio.data : null}
                    viewport={viewport}
                    height={spectrogramHeight}
                    themeColor={themeColor}
                    onUnavailable={onUnavailable}
                    onReady={onReady}
                />
            )}
        </div>
    );
});

Waveform.displayName = "Waveform";
