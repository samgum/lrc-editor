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
    centerAt: (timeSeconds: number) => void;
    setZoom: (pixelsPerSecond: number) => void;
    setAmplitude: (amplitude: number) => void;
}

export const Waveform = forwardRef<WaveformHandle, IWaveformProps>(({
    source,
    themeColor,
    onSeek,
    onUnavailable,
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
    const { wavesurfer } = useWavesurfer({
        container: containerRef,
        url: source,
        media: audioRef.current || undefined,
        waveColor: "#eeeeee",
        progressColor: initialThemeColor.current,
        cursorColor: initialThemeColor.current,
        normalize,
        barHeight,
        height,
        barWidth: 2,
        barGap: 1,
        barRadius: 2,
        cursorWidth: 2,
        interact: true,
        dragToSeek: !pointMode,
        minPxPerSec,
        autoScroll,
        autoCenter: autoScroll,
    });

    useImperativeHandle(ref, () => ({
        scrollPage: (direction) => {
            if (!wavesurfer) return;
            wavesurfer.setScroll(wavesurfer.getScroll() + direction * wavesurfer.getWidth() * 0.72);
        },
        centerAt: (timeSeconds) => wavesurfer?.setScrollTime(Math.max(0, timeSeconds)),
        setZoom: (pixelsPerSecond) => {
            if (wavesurfer?.getDecodedData()) wavesurfer.zoom(pixelsPerSecond);
        },
        setAmplitude: (amplitude) => wavesurfer?.setOptions({ barHeight: amplitude }),
    }), [wavesurfer]);

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
        return wavesurfer?.on("error", () => onUnavailable());
    }, [onUnavailable, wavesurfer]);

    useEffect(() => {
        wavesurfer?.setOptions({
            waveColor: "#eeeeee",
            progressColor: themeColor,
            cursorColor: themeColor,
        });
    }, [themeColor, visualization, wavesurfer]);

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
        }).catch(() => onUnavailable());
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
