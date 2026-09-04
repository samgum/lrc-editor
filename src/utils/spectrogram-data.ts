export interface SpectrogramData {
    values: Uint8Array<ArrayBuffer>;
    columns: number;
    bins: number;
    hop: number;
    fftSize: number;
    sampleRate: number;
}

const maximumFrequencyBytes = 16 * 1024 * 1024;
let cached: { source: string; data: SpectrogramData } | undefined;

export const readSpectrogramData = (source: string): SpectrogramData | undefined =>
    cached?.source === source ? cached.data : undefined;
export const cacheSpectrogramData = (source: string, data: SpectrogramData): void => {
    cached = data.values.byteLength <= maximumFrequencyBytes ? { source, data } : undefined;
};
export const clearOtherSpectrogramData = (source: string): void => {
    if (cached?.source !== source) cached = undefined;
};

export const spectrogramLayout = (length: number): Pick<SpectrogramData, "fftSize" | "bins" | "hop" | "columns"> => {
    if (!Number.isSafeInteger(length) || length <= 0) throw new Error("INVALID_SPECTRUM_AUDIO");
    const fftSize = 1024;
    const bins = fftSize / 2;
    const hop = Math.max(fftSize / 4, Math.ceil(length * bins / maximumFrequencyBytes));
    const columns = Math.ceil(length / hop);
    return { fftSize, bins, hop, columns };
};

export const calculateSpectrogram = (channels: readonly Float32Array[], sampleRate: number): SpectrogramData => {
    const length = channels[0]?.length || 0;
    if (!length || !Number.isFinite(sampleRate) || sampleRate <= 0) throw new Error("INVALID_SPECTRUM_AUDIO");
    const { fftSize, bins, hop, columns } = spectrogramLayout(length);
    const values = new Uint8Array(columns * bins);
    const real = new Float64Array(fftSize);
    const imaginary = new Float64Array(fftSize);
    const power = new Float64Array(bins);
    const window = Float64Array.from(
        { length: fftSize },
        (_, index) => 0.5 - 0.5 * Math.cos(2 * Math.PI * index / (fftSize - 1)),
    );
    const reverse = Uint16Array.from({ length: fftSize }, (_, index) => {
        let result = 0;
        for (let bit = 0; bit < 10; bit++) result = result * 2 + (index >>> bit & 1);
        return result;
    });
    for (let column = 0; column < columns; column++) {
        power.fill(0);
        const start = column * hop - fftSize / 2;
        for (const channel of channels) {
            for (let index = 0; index < fftSize; index++) {
                real[reverse[index]] = (channel[start + index] || 0) * window[index];
            }
            imaginary.fill(0);
            for (let size = 2; size <= fftSize; size *= 2) {
                const half = size / 2;
                const cosine = Math.cos(-2 * Math.PI / size);
                const sine = Math.sin(-2 * Math.PI / size);
                for (let block = 0; block < fftSize; block += size) {
                    let unitReal = 1;
                    let unitImaginary = 0;
                    for (let index = 0; index < half; index++) {
                        const left = block + index;
                        const right = left + half;
                        const nextReal = unitReal * real[right] - unitImaginary * imaginary[right];
                        const nextImaginary = unitReal * imaginary[right] + unitImaginary * real[right];
                        real[right] = real[left] - nextReal;
                        imaginary[right] = imaginary[left] - nextImaginary;
                        real[left] += nextReal;
                        imaginary[left] += nextImaginary;
                        const rotatedReal = unitReal * cosine - unitImaginary * sine;
                        unitImaginary = unitReal * sine + unitImaginary * cosine;
                        unitReal = rotatedReal;
                    }
                }
            }
            for (let bin = 0; bin < bins; bin++) power[bin] += real[bin] ** 2 + imaginary[bin] ** 2;
        }
        for (let bin = 0; bin < bins; bin++) {
            const magnitude = Math.sqrt(power[bin] / channels.length) / (fftSize / 2);
            const decibels = 20 * Math.log10(Math.max(1e-12, magnitude));
            values[column * bins + bin] = Math.max(0, Math.min(255, Math.round((decibels + 90) / 90 * 255)));
        }
    }
    return { values, columns, bins, hop, fftSize, sampleRate };
};

export const spectrumFrequencyAt = (fractionFromTop: number, maximum: number): number => {
    const low = Math.log1p(40 / 700);
    const high = Math.log1p(maximum / 700);
    return 700 * Math.expm1(high - Math.max(0, Math.min(1, fractionFromTop)) * (high - low));
};

export const spectrumFractionAt = (frequency: number, maximum: number): number => {
    const low = Math.log1p(40 / 700);
    const high = Math.log1p(maximum / 700);
    return (high - Math.log1p(frequency / 700)) / (high - low);
};
