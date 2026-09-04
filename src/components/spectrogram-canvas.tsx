import { useEffect, useRef, useState } from "react";
import {
    cacheSpectrogramData,
    readSpectrogramData,
    type SpectrogramData,
    spectrumFractionAt,
    spectrumFrequencyAt,
} from "../utils/spectrogram-data.js";
import type { WaveformViewport } from "./waveform.js";

export const SpectrogramCanvas: React.FC<{
    source: string;
    audio: AudioBuffer | null;
    viewport: WaveformViewport;
    height: number;
    themeColor: string;
    onUnavailable: () => void;
    onReady?: () => void;
}> = ({ source, audio, viewport, height, themeColor, onUnavailable, onReady }) => {
    const canvas = useRef<HTMLCanvasElement>(null);
    const [spectrum, setSpectrum] = useState(() => readSpectrogramData(source));

    useEffect(() => {
        const saved = readSpectrogramData(source);
        setSpectrum(saved);
        if (saved || !audio) return;
        let active = true;
        let worker: Worker;
        try {
            worker = new Worker(new URL("../workers/spectrogram.worker.ts", import.meta.url), { type: "module" });
        } catch {
            onUnavailable();
            return;
        }
        const timer = setTimeout(() => {
            if (!active) return;
            worker.terminate();
            onUnavailable();
        }, 30_000);
        worker.onmessage = (event: MessageEvent<{ ok: boolean; data: SpectrogramData }>) => {
            if (!active) return;
            clearTimeout(timer);
            worker.terminate();
            if (!event.data.ok) {
                onUnavailable();
                return;
            }
            cacheSpectrogramData(source, event.data.data);
            setSpectrum(event.data.data);
        };
        worker.onerror = () => {
            if (!active) return;
            clearTimeout(timer);
            worker.terminate();
            onUnavailable();
        };
        try {
            worker.postMessage({
                channels: Array.from({ length: audio.numberOfChannels }, (_, index) => audio.getChannelData(index)),
                sampleRate: audio.sampleRate,
            });
        } catch {
            active = false;
            clearTimeout(timer);
            worker.terminate();
            onUnavailable();
        }
        return () => {
            active = false;
            clearTimeout(timer);
            worker.terminate();
        };
    }, [audio, onUnavailable, source]);

    useEffect(() => {
        const target = canvas.current;
        if (!target || !spectrum || viewport.width <= 0 || height <= 0) return;
        const frame = requestAnimationFrame(() => {
            try {
                paintSpectrum(target, spectrum, viewport, height, themeColor);
                onReady?.();
            } catch {
                onUnavailable();
            }
        });
        return () => cancelAnimationFrame(frame);
    }, [height, onReady, onUnavailable, spectrum, themeColor, viewport]);

    return <canvas className="timing-spectrogram" ref={canvas} aria-hidden="true" data-ready={Boolean(spectrum)} />;
};

const paintSpectrum = (
    canvas: HTMLCanvasElement,
    data: SpectrogramData,
    viewport: WaveformViewport,
    height: number,
    themeColor: string,
): void => {
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(viewport.width * ratio));
    const pixelsHigh = Math.max(1, Math.round(height * ratio));
    const maximum = Math.min(12_000, data.sampleRate / 2);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("SPECTROGRAM_CANVAS_UNAVAILABLE");
    const pixels = context.createImageData(width, pixelsHigh);
    const color =
        /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/iu.exec(themeColor)?.slice(1).map((part) => Number.parseInt(part, 16))
        || [245, 142, 168];
    const colors = Array.from({ length: 256 }, (_, value) => {
        const strength = value / 255;
        return color.map((channel, index) =>
            strength < 0.7
                ? [13, 15, 20][index] + (channel - [13, 15, 20][index]) * strength / 0.7
                : channel + (255 - channel) * (strength - 0.7) / 0.3
        );
    });
    const frequencies = Float64Array.from(
        { length: pixelsHigh },
        (_, y) =>
            Math.min(data.bins - 1, spectrumFrequencyAt(y / pixelsHigh, maximum) * data.fftSize / data.sampleRate),
    );
    for (let x = 0; x < width; x++) {
        const time = viewport.start + x / ratio / viewport.pixelsPerSecond;
        const position = Math.max(0, Math.min(data.columns - 1, time * data.sampleRate / data.hop));
        const firstColumn = Math.floor(position);
        const secondColumn = Math.min(data.columns - 1, firstColumn + 1);
        const columnMix = position - firstColumn;
        for (let y = 0; y < pixelsHigh; y++) {
            const bin = Math.floor(frequencies[y]);
            const nextBin = Math.min(data.bins - 1, bin + 1);
            const binMix = frequencies[y] - bin;
            const first = data.values[firstColumn * data.bins + bin] * (1 - binMix)
                + data.values[firstColumn * data.bins + nextBin] * binMix;
            const second = data.values[secondColumn * data.bins + bin] * (1 - binMix)
                + data.values[secondColumn * data.bins + nextBin] * binMix;
            const color = colors[Math.round(first * (1 - columnMix) + second * columnMix)];
            const pixel = (y * width + x) * 4;
            pixels.data[pixel] = color[0];
            pixels.data[pixel + 1] = color[1];
            pixels.data[pixel + 2] = color[2];
            pixels.data[pixel + 3] = 255;
        }
    }
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== pixelsHigh) canvas.height = pixelsHigh;
    context.putImageData(pixels, 0, 0);
    context.save();
    context.scale(ratio, ratio);
    context.font = "11px system-ui, sans-serif";
    context.textBaseline = "middle";
    let lastLabel = -Infinity;
    for (const frequency of [12_000, 8_000, 4_000, 2_000, 1_000, 500, 250, 100, 40]) {
        if (frequency > maximum) continue;
        const y = Math.max(10, Math.min(height - 10, spectrumFractionAt(frequency, maximum) * height));
        if (y - lastLabel < 24) continue;
        const text = frequency >= 1000 ? `${frequency / 1000}k` : String(frequency);
        context.fillStyle = "#0d0f14d9";
        context.fillRect(0, y - 8, 39, 16);
        context.fillStyle = "#f1f3f7";
        context.fillText(text, 5, y);
        lastLabel = y;
    }
    context.restore();
};
