export interface BeatGrid {
    enabled: boolean;
    snap: boolean;
    bpm: number;
    offset: number;
    subdivision: 1 | 2 | 4 | 8;
    beatsPerBar: number;
}

export interface BeatGridLine {
    time: number;
    x: number;
    kind: "bar" | "beat" | "subdivision";
    bar: number;
}

const savedGrids = new Map<string, BeatGrid>();

export const defaultBeatGrid = (): BeatGrid => ({
    enabled: false,
    snap: false,
    bpm: 120,
    offset: 0,
    subdivision: 1,
    beatsPerBar: 4,
});

export const normalizeBeatGrid = (grid: BeatGrid): BeatGrid => ({
    enabled: grid.enabled === true,
    snap: grid.snap === true,
    bpm: Number.isFinite(grid.bpm) ? Math.max(20, Math.min(400, grid.bpm)) : 120,
    offset: Number.isFinite(grid.offset) ? Math.max(-86_400, Math.min(86_400, grid.offset)) : 0,
    subdivision: [1, 2, 4, 8].includes(grid.subdivision) ? grid.subdivision : 1,
    beatsPerBar: Number.isFinite(grid.beatsPerBar) ? Math.max(1, Math.min(16, Math.round(grid.beatsPerBar))) : 4,
});

export const readBeatGrid = (source: string): BeatGrid => ({ ...(savedGrids.get(source) || defaultBeatGrid()) });

export const saveBeatGrid = (source: string, grid: BeatGrid): void => {
    savedGrids.delete(source);
    savedGrids.set(source, normalizeBeatGrid(grid));
    while (savedGrids.size > 3) savedGrids.delete(savedGrids.keys().next().value!);
};

export const beatGridLines = (
    value: BeatGrid,
    start: number,
    end: number,
    pixelsPerSecond: number,
    duration: number,
): BeatGridLine[] => {
    if (!value.enabled || ![start, end, pixelsPerSecond, duration].every(Number.isFinite)) return [];
    if (end <= start || pixelsPerSecond <= 0 || duration <= 0) return [];
    const grid = normalizeBeatGrid(value);
    const step = 60 / grid.bpm / grid.subdivision;
    let stride: number = step * pixelsPerSecond < 8 ? grid.subdivision : 1;
    const barStride = grid.subdivision * grid.beatsPerBar;
    if (step * stride * pixelsPerSecond < 8) stride = barStride;
    if (step * stride * pixelsPerSecond < 8) stride *= Math.ceil(8 / (step * stride * pixelsPerSecond));
    const first = Math.ceil((Math.max(0, start) - grid.offset) / step / stride) * stride;
    const last = Math.floor((Math.min(duration, end) - grid.offset) / step);
    const lines: BeatGridLine[] = [];
    for (let index = first; index <= last && lines.length < 512; index += stride) {
        const time = grid.offset + index * step;
        const kind = index % barStride === 0 ? "bar" : index % grid.subdivision === 0 ? "beat" : "subdivision";
        lines.push({ time, x: (time - start) * pixelsPerSecond, kind, bar: Math.floor(index / barStride) + 1 });
    }
    return lines;
};

export const snapToBeatGrid = (
    time: number,
    value: BeatGrid,
    pixelsPerSecond: number,
    duration: number,
    bypass = false,
): { time: number; snapped: boolean } => {
    const unchanged = { time, snapped: false };
    if (bypass || !value.enabled || !value.snap || ![time, pixelsPerSecond, duration].every(Number.isFinite)) {
        return unchanged;
    }
    if (pixelsPerSecond <= 0 || duration <= 0) return unchanged;
    const grid = normalizeBeatGrid(value);
    const step = 60 / grid.bpm / grid.subdivision;
    const candidate = grid.offset + Math.round((time - grid.offset) / step) * step;
    const tolerance = Math.min(12 / pixelsPerSecond, step * 0.3);
    if (candidate < 0 || candidate > duration || Math.abs(candidate - time) > tolerance) return unchanged;
    return { time: candidate, snapped: true };
};

export const addTempoTap = (previous: readonly number[], time: number): number[] => {
    if (!Number.isFinite(time)) return [...previous];
    const gap = time - (previous.at(-1) ?? -Infinity);
    if (gap <= 0 || gap > 3_000) return [time];
    if (gap < 120) return [...previous];
    return [...previous, time].slice(-9);
};

export const tappedBpm = (taps: readonly number[]): number | undefined => {
    if (taps.length < 3) return undefined;
    const gaps = taps.slice(1).map((time, index) => time - taps[index]).filter((gap) => gap >= 150 && gap <= 3_000);
    if (gaps.length < 2) return undefined;
    const sorted = [...gaps].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const close = gaps.filter((gap) => Math.abs(gap - median) <= median * 0.25);
    if (close.length < 2) return undefined;
    return Math.round(60_000 / (close.reduce((sum, gap) => sum + gap, 0) / close.length) * 100) / 100;
};
