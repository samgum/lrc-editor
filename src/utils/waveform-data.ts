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
