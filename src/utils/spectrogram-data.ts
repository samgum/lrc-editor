export interface SpectrogramData {
    values: Uint8Array<ArrayBuffer>;
    columns: number;
    bins: number;
    hop: number;
    fftSize: number;
    sampleRate: number;
    estimatedBpm?: number;
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
    const twiddleReal = new Float64Array(fftSize);
    const twiddleImag = new Float64Array(fftSize);
    for (let size = 2; size <= fftSize; size *= 2) {
        const half = size / 2;
        for (let index = 0; index < half; index++) {
            const angle = -2 * Math.PI * index / size;
            twiddleReal[half + index] = Math.cos(angle);
            twiddleImag[half + index] = Math.sin(angle);
        }
    }
    const scaleNorm = 1 / (fftSize / 2);
    const binWeight = Float64Array.from({ length: bins }, (_, bin) => {
        const freq = bin * sampleRate / fftSize;
        if (freq < 180) return 0.3 + 0.7 * (freq / 180);
        if (freq <= 3_500) return 1.45;
        return 0.78;
    });
    const binDb = new Float64Array(bins);
    for (let column = 0; column < columns; column++) {
        power.fill(0);
        const start = column * hop - fftSize / 2;
        const firstValid = Math.max(0, -start);
        for (const channel of channels) {
            const lastValid = Math.min(fftSize, channel.length - start);
            real.fill(0);
            for (let index = firstValid; index < lastValid; index++) {
                real[reverse[index]] = channel[start + index] * window[index];
            }
            imaginary.fill(0);
            for (let size = 2; size <= fftSize; size *= 2) {
                const half = size / 2;
                for (let block = 0; block < fftSize; block += size) {
                    for (let index = 0; index < half; index++) {
                        const left = block + index;
                        const right = left + half;
                        const unitReal = twiddleReal[half + index];
                        const unitImaginary = twiddleImag[half + index];
                        const nextReal = unitReal * real[right] - unitImaginary * imaginary[right];
                        const nextImaginary = unitReal * imaginary[right] + unitImaginary * real[right];
                        real[right] = real[left] - nextReal;
                        imaginary[right] = imaginary[left] - nextImaginary;
                        real[left] += nextReal;
                        imaginary[left] += nextImaginary;
                    }
                }
            }
            for (let bin = 0; bin < bins; bin++) {
                power[bin] += real[bin] * real[bin] + imaginary[bin] * imaginary[bin];
            }
        }
        for (let bin = 0; bin < bins; bin++) {
            const magnitude = Math.sqrt(power[bin] / channels.length) * scaleNorm * binWeight[bin];
            binDb[bin] = 20 * Math.log10(Math.max(1e-12, magnitude));
        }
        const columnOffset = column * bins;
        for (let bin = 0; bin < bins; bin++) {
            // Subtract half of the local broadband floor so narrow vocal harmonics pop out over flat synths/noise.
            const lo = Math.max(0, bin - 8);
            const hi = Math.min(bins - 1, bin + 8);
            let localSum = 0;
            for (let k = lo; k <= hi; k++) localSum += binDb[k];
            const localAvg = localSum / (hi - lo + 1);
            const headroom = Math.max(0, -binDb[bin]);
            const contrastDb = binDb[bin] + Math.min(headroom * 0.5, Math.max(0, binDb[bin] - localAvg) * 0.65);
            values[columnOffset + bin] = Math.max(0, Math.min(255, Math.round((contrastDb + 62) / 62 * 255)));
        }
    }
    const data: SpectrogramData = { values, columns, bins, hop, fftSize, sampleRate };
    data.estimatedBpm = estimateBpmFromSpectrogram(data);
    return data;
};

export const estimateBpmFromSpectrogram = (
    data: Pick<SpectrogramData, "values" | "columns" | "bins" | "hop" | "sampleRate">,
): number | undefined => {
    const frameRate = data.sampleRate / data.hop;
    const duration = data.columns / frameRate;
    if (!Number.isFinite(duration) || duration < 8 || data.columns < 64) return undefined;

    const maxBin = Math.min(data.bins, 96);
    const flux = new Float32Array(data.columns);
    let totalFlux = 0;
    for (let col = 1; col < data.columns; col++) {
        const cur = col * data.bins;
        const prev = (col - 1) * data.bins;
        let sum = 0;
        for (let bin = 2; bin < maxBin; bin += 2) {
            const diff = data.values[cur + bin] - data.values[prev + bin];
            if (diff > 0) sum += diff;
        }
        flux[col] = sum;
        totalFlux += sum;
    }
    if (totalFlux <= 0) return undefined;

    // Subtract local mean so sustained pads don't bias autocorrelation, then evaluate 65..175 BPM.
    const onset = new Float32Array(data.columns);
    const halfWin = Math.max(4, Math.round(frameRate * 0.25));
    for (let col = 0; col < data.columns; col++) {
        const lo = Math.max(0, col - halfWin);
        const hi = Math.min(data.columns - 1, col + halfWin);
        let sum = 0;
        for (let k = lo; k <= hi; k++) sum += flux[k];
        const mean = sum / (hi - lo + 1);
        onset[col] = Math.max(0, flux[col] - mean);
    }

    const analysisCols = Math.min(data.columns, Math.round(frameRate * 90));
    const stride = Math.max(1, Math.floor(analysisCols / 3000));
    let bestBpm = 0;
    let bestScore = 0;
    for (let bpm = 65; bpm <= 175; bpm++) {
        const lag = Math.round(frameRate * 60 / bpm);
        if (lag <= 1 || lag >= analysisCols / 2) continue;
        let score = 0;
        for (let col = 0; col + lag < analysisCols; col += stride) {
            score += onset[col] * onset[col + lag];
        }
        // Slight preference for typical pop/dance 85..155 BPM to avoid half-tempo picks.
        const weight = bpm >= 85 && bpm <= 155 ? 1.08 : 1;
        if (score * weight > bestScore) {
            bestScore = score * weight;
            bestBpm = bpm;
        }
    }
    return bestBpm > 0 ? bestBpm : undefined;
};

export const spectrumFrequencyAt = (fractionFromTop: number, maximum: number): number => {
    const safeMax = Math.max(80, maximum);
    const low = Math.log1p(40 / 300);
    const high = Math.log1p(safeMax / 300);
    return 300 * Math.expm1(high - Math.max(0, Math.min(1, fractionFromTop)) * (high - low));
};

export const spectrumFractionAt = (frequency: number, maximum: number): number => {
    const safeMax = Math.max(80, maximum);
    const low = Math.log1p(40 / 300);
    const high = Math.log1p(safeMax / 300);
    return (high - Math.log1p(frequency / 300)) / (high - low);
};
