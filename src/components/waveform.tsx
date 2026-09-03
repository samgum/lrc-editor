import { useWavesurfer } from "@wavesurfer/react";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { audioRef } from "../utils/audiomodule";
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
    onPoint?: (time: number) => void;
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
    onPoint,
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
    const cachedPeaksRef = useRef({ source, value: waveformPeakCache.get(source) });
    if (cachedPeaksRef.current.source !== source) {
        cachedPeaksRef.current = { source, value: waveformPeakCache.get(source) };
    }
    const cachedPeaks = cachedPeaksRef.current.value;
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
        interact: true,
        dragToSeek: !pointMode,
        minPxPerSec: creationOptionsRef.current.minPxPerSec,
        autoScroll,
        autoCenter: autoScroll,
        peaks: cachedPeaks?.peaks,
        duration: cachedPeaks?.duration,
    });

    const timeAtOffset = (offsetPixels: number): number => {
        if (!wavesurfer) return 0;
        const duration = wavesurfer.getDuration();
        const pixelsPerSecond = pixelsPerSecondRef.current || wavesurfer.getWidth() / Math.max(duration, 0.001);
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
            const pixelsPerSecond = pixelsPerSecondRef.current
                || wavesurfer.getWidth() / Math.max(wavesurfer.getDuration(), 0.001);
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
            const pixelsPerSecond = pixelsPerSecondRef.current
                || wavesurfer.getWidth() / Math.max(wavesurfer.getDuration(), 0.001);
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
                const pixelsPerSecond = pixelsPerSecondRef.current
                    || wavesurfer.getWidth() / Math.max(wavesurfer.getDuration(), 0.001);
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
    }, [source]);

    useEffect(() => {
        if (!wavesurfer) return;
        return wavesurfer.on("ready", () => {
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
            onReady?.();
        });
    }, [onReady, source, wavesurfer]);

    useEffect(() => {
        return wavesurfer?.on("interaction", (currentTime) => {
            onSeek(currentTime);
        });
    }, [wavesurfer, onSeek]);

    useEffect(() => {
        if (!onPoint) return;
        return wavesurfer?.on("click", (relativeX) => {
            onPoint(relativeX * wavesurfer.getDuration());
        });
    }, [onPoint, wavesurfer]);

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

    useEffect(() => {
        if (!wavesurfer || visualization !== "spectrogram") return;
        let active = true;
        let plugin: { destroy: () => void } | undefined;
        void import("wavesurfer.js/dist/plugins/spectrogram.esm.js").then(({ default: Spectrogram }) => {
            if (!active) return;
            plugin = wavesurfer.registerPlugin(Spectrogram.create({
                height: spectrogramHeight,
                labels: true,
                scale: "mel",
                frequencyMin: 60,
                frequencyMax: 12_000,
                fftSamples: 1024,
                colorMap: createSpectrogramColorMap(themeColor),
                gainDB: 40,
                rangeDB: 75,
                useWebWorker: true,
            }));
        }).catch(() => {
            if (errorReportedRef.current) return;
            errorReportedRef.current = true;
            onUnavailable();
        });
        return () => {
            active = false;
            plugin?.destroy();
        };
    }, [onUnavailable, spectrogramHeight, themeColor, visualization, wavesurfer]);

    return (
        <div
            className={`waveform ${className || ""}`}
            ref={containerRef}
            aria-label={ariaLabel}
            style={visualization === "spectrogram" ? { filter: `brightness(${barHeight})` } : undefined}
        >
        </div>
    );
});

Waveform.displayName = "Waveform";

const createSpectrogramColorMap = (themeColor: string): number[][] => {
    const channels = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/iu.exec(themeColor)?.slice(1)
        .map((channel) => Number.parseInt(channel, 16) / 255) || [0.96, 0.56, 0.66];
    return Array.from({ length: 256 }, (_, index) => {
        const strength = index / 255;
        if (strength < 0.68) {
            const ratio = strength / 0.68;
            return channels.map((channel) => channel * ratio) as number[];
        }
        const ratio = (strength - 0.68) / 0.32;
        return [...channels.map((channel) => channel + (1 - channel) * ratio), 1];
    }).map((entry) => entry.length === 4 ? entry : [...entry, 1]);
};
