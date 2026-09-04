import { calculateSpectrogram } from "../utils/spectrogram-data.js";

const worker = self as unknown as DedicatedWorkerGlobalScope & EventTarget;
worker.addEventListener("message", (event) => {
    try {
        const message = (event as MessageEvent<{ channels: Float32Array[]; sampleRate: number }>).data;
        const data = calculateSpectrogram(message.channels, message.sampleRate);
        worker.postMessage({ ok: true, data }, [data.values.buffer]);
    } catch {
        worker.postMessage({ ok: false });
    }
});
