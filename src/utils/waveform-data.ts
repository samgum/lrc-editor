export const timingSampleRate = 24_000;

export interface TimingPcm {
    source: string;
    duration: number;
    channels: Float32Array[];
}

let timingPcm: TimingPcm | undefined;

export const readTimingPcm = (source: string): TimingPcm | undefined =>
    timingPcm?.source === source ? timingPcm : undefined;

export const cacheTimingPcm = (source: string, data: AudioBuffer): void => {
    if (Math.abs(data.sampleRate - timingSampleRate) > 1 || data.duration <= 0) return;
    const size = data.length * data.numberOfChannels * Float32Array.BYTES_PER_ELEMENT;
    if (size > 64 * 1024 * 1024) {
        timingPcm = undefined;
        return;
    }
    timingPcm = {
        source,
        duration: data.duration,
        channels: Array.from({ length: data.numberOfChannels }, (_, index) => data.getChannelData(index)),
    };
};

export const clearOtherTimingPcm = (source: string): void => {
    if (timingPcm?.source !== source) timingPcm = undefined;
};

export const waveformPixelsPerSecond = (zoom: number, width: number, duration: number): number =>
    Math.max(Number.isFinite(zoom) ? zoom : 0, duration > 0 && Number.isFinite(duration) ? width / duration : 1, 1);

export const timingPanelHeights = (height: number, spectrum: boolean): { wave: number; spectrum: number } => {
    const available = Math.max(100, Math.round(height) - 16);
    return { wave: spectrum ? 1 : available, spectrum: spectrum ? available : 0 };
};

export interface WaveformColumn {
    readonly peak: number;
    readonly rms: number;
}

const HEADROOM_SCALE = 0.86;

export const computeWaveformColumns = (
    channels: readonly (Float32Array | number[])[],
    width: number,
    amplitude: number,
): WaveformColumn[] => {
    const pixelWidth = Math.max(0, Math.floor(width));
    const channel = channels[0];
    if (pixelWidth === 0 || !channel || channel.length === 0) return [];
    const safeAmplitude = Number.isFinite(amplitude) && amplitude > 0 ? amplitude : 1;
    const sampleCount = channel.length;
    const samplesPerPixel = sampleCount / pixelWidth;
    const columns: WaveformColumn[] = [];

    for (let x = 0; x < pixelWidth; x += 1) {
        const start = Math.floor(x * samplesPerPixel);
        const end = Math.max(start + 1, Math.min(sampleCount, Math.floor((x + 1) * samplesPerPixel)));
        let maxAbs = 0;
        let sumSq = 0;
        let count = 0;
        for (let i = start; i < end; i += 1) {
            const abs = Math.abs(channel[i]);
            if (abs > maxAbs) maxAbs = abs;
            sumSq += abs * abs;
            count += 1;
        }
        const rms = count > 0 ? Math.sqrt(sumSq / count) : 0;
        const peak = Math.min(1, (maxAbs ** 1.35) * safeAmplitude * HEADROOM_SCALE);
        const core = Math.min(peak, (rms ** 1.15) * safeAmplitude * HEADROOM_SCALE);
        columns.push({ peak, rms: core });
    }
    return columns;
};

export const renderDetailedWaveform = (
    peaks: readonly (Float32Array | number[])[],
    ctx: CanvasRenderingContext2D,
    amplitude: number,
): void => {
    const { width, height } = ctx.canvas;
    const columns = computeWaveformColumns(peaks, width, amplitude);
    if (columns.length === 0 || height <= 0) return;
    const halfHeight = height / 2;
    const previousAlpha = ctx.globalAlpha;

    ctx.globalAlpha = 0.34;
    for (let x = 0; x < columns.length; x += 1) {
        const bar = Math.max(1, columns[x].peak * halfHeight);
        ctx.fillRect(x, halfHeight - bar, 1, bar * 2);
    }

    ctx.globalAlpha = 1;
    for (let x = 0; x < columns.length; x += 1) {
        const core = columns[x].rms * halfHeight;
        if (core >= 0.5) {
            ctx.fillRect(x, halfHeight - core, 1, core * 2);
        }
    }

    ctx.globalAlpha = 0.25;
    ctx.fillRect(0, Math.floor(halfHeight), width, 1);
    ctx.globalAlpha = previousAlpha;
};
