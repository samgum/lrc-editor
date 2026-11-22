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

interface CachedSpectrogramAtlas {
    data: SpectrogramData;
    pixelsHigh: number;
    themeColor: string;
    tileColumns: number;
    tiles: HTMLCanvasElement[];
}

const tileMaxColumns = 4096;
let cachedAtlas: CachedSpectrogramAtlas | null = null;

const getSpectrogramAtlas = (
    data: SpectrogramData,
    pixelsHigh: number,
    themeColor: string,
    maximum: number,
): CachedSpectrogramAtlas => {
    if (
        cachedAtlas
        && cachedAtlas.data === data
        && cachedAtlas.pixelsHigh === pixelsHigh
        && cachedAtlas.themeColor === themeColor
    ) {
        return cachedAtlas;
    }
    const paletteR = new Uint8Array(256);
    const paletteG = new Uint8Array(256);
    const paletteB = new Uint8Array(256);
    const stops: readonly (readonly [number, number, number, number])[] = [
        [0.0, 11, 13, 20],
        [0.22, 28, 22, 74],
        [0.45, 106, 27, 110],
        [0.66, 214, 54, 72],
        [0.84, 255, 148, 36],
        [0.95, 255, 232, 117],
        [1.0, 255, 252, 240],
    ];
    for (let v = 0; v < 256; v++) {
        const strength = (v / 255) ** 1.35;
        let stopIndex = 0;
        while (stopIndex < stops.length - 2 && strength > stops[stopIndex + 1][0]) {
            stopIndex += 1;
        }
        const [t0, r0, g0, b0] = stops[stopIndex];
        const [t1, r1, g1, b1] = stops[stopIndex + 1];
        const local = t1 > t0 ? Math.max(0, Math.min(1, (strength - t0) / (t1 - t0))) : 0;
        paletteR[v] = Math.round(r0 + (r1 - r0) * local);
        paletteG[v] = Math.round(g0 + (g1 - g0) * local);
        paletteB[v] = Math.round(b0 + (b1 - b0) * local);
    }
    const binFloor = new Int32Array(pixelsHigh);
    const binNext = new Int32Array(pixelsHigh);
    const binMix = new Float64Array(pixelsHigh);
    for (let y = 0; y < pixelsHigh; y++) {
        const freq = Math.min(
            data.bins - 1,
            spectrumFrequencyAt(y / pixelsHigh, maximum) * data.fftSize / data.sampleRate,
        );
        const floor = Math.floor(freq);
        binFloor[y] = floor;
        binNext[y] = Math.min(data.bins - 1, floor + 1);
        binMix[y] = freq - floor;
    }

    const totalTiles = Math.max(1, Math.ceil(data.columns / tileMaxColumns));
    const tiles: HTMLCanvasElement[] = [];
    for (let tileIndex = 0; tileIndex < totalTiles; tileIndex++) {
        const colStart = tileIndex * tileMaxColumns;
        const colCount = Math.min(tileMaxColumns, Math.max(1, data.columns - colStart));
        const tile = document.createElement("canvas");
        tile.width = colCount;
        tile.height = pixelsHigh;
        const tileCtx = tile.getContext("2d");
        if (!tileCtx) throw new Error("SPECTROGRAM_CANVAS_UNAVAILABLE");
        const img = tileCtx.createImageData(colCount, pixelsHigh);
        const out = img.data;
        for (let localCol = 0; localCol < colCount; localCol++) {
            const colOffset = Math.min(data.columns - 1, colStart + localCol) * data.bins;
            for (let y = 0; y < pixelsHigh; y++) {
                const b0 = binFloor[y];
                const b1 = binNext[y];
                const m = binMix[y];
                const val = Math.round(data.values[colOffset + b0] * (1 - m) + data.values[colOffset + b1] * m);
                const idx = (y * colCount + localCol) * 4;
                out[idx] = paletteR[val];
                out[idx + 1] = paletteG[val];
                out[idx + 2] = paletteB[val];
                out[idx + 3] = 255;
            }
        }
        tileCtx.putImageData(img, 0, 0);
        tiles.push(tile);
    }

    cachedAtlas = {
        data,
        pixelsHigh,
        themeColor,
        tileColumns: tileMaxColumns,
        tiles,
    };
    return cachedAtlas;
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
    const maximum = Math.max(80, Math.min(12_000, data.sampleRate / 2));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("SPECTROGRAM_CANVAS_UNAVAILABLE");
    const atlas = getSpectrogramAtlas(data, pixelsHigh, themeColor, maximum);
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== pixelsHigh) canvas.height = pixelsHigh;

    context.fillStyle = "#0d0f14";
    context.fillRect(0, 0, width, pixelsHigh);
    context.imageSmoothingEnabled = true;

    const columnsPerSec = data.sampleRate / data.hop;
    const startCol = Math.max(0, viewport.start * columnsPerSec);
    const endCol = Math.min(data.columns, (viewport.start + width / ratio / viewport.pixelsPerSecond) * columnsPerSec);
    const spanCols = endCol - startCol;
    if (spanCols > 0) {
        const firstTile = Math.floor(startCol / atlas.tileColumns);
        const lastTile = Math.min(atlas.tiles.length - 1, Math.floor(endCol / atlas.tileColumns));
        for (let tileIdx = firstTile; tileIdx <= lastTile; tileIdx++) {
            const tile = atlas.tiles[tileIdx];
            const tileColOrigin = tileIdx * atlas.tileColumns;
            const segStart = Math.max(startCol, tileColOrigin);
            const segEnd = Math.min(endCol, tileColOrigin + tile.width);
            if (segEnd <= segStart) continue;
            const dstX = (segStart - startCol) / spanCols * width;
            const dstW = (segEnd - segStart) / spanCols * width;
            context.drawImage(
                tile,
                segStart - tileColOrigin,
                0,
                segEnd - segStart,
                pixelsHigh,
                dstX,
                0,
                dstW,
                pixelsHigh,
            );
        }
    }
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
