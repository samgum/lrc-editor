type WaveformTimingHandler = (timeSeconds: number) => void;

let activeHandler: WaveformTimingHandler | null = null;
const listeners = new Set<() => void>();

const notify = (): void => listeners.forEach((listener) => listener());

export const setWaveformTimingHandler = (handler: WaveformTimingHandler): () => void => {
    activeHandler = handler;
    notify();
    return () => {
        if (activeHandler !== handler) return;
        activeHandler = null;
        notify();
    };
};

export const captureWaveformTime = (timeSeconds: number): boolean => {
    if (!activeHandler) return false;
    activeHandler(timeSeconds);
    return true;
};

export const waveformTimingActive = (): boolean => activeHandler !== null;

export const subscribeWaveformTiming = (listener: () => void): () => void => {
    listeners.add(listener);
    return () => listeners.delete(listener);
};
