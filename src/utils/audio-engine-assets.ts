const maximumWasmBytes = 64 * 1024 * 1024;
const downloadIdleTimeoutMs = 30_000;

interface WasmManifest {
    size: number;
    parts: string[];
}

export class AudioEngineDownloadError extends Error {
    constructor(readonly cause: unknown) {
        super("Unable to download the browser audio conversion engine");
        this.name = "AudioEngineDownloadError";
    }
}

export const loadAudioEngineWasmUrl = async (base: URL): Promise<string> => {
    let failure: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            return await downloadWasm(base, attempt === 0 ? "force-cache" : "reload");
        } catch (error) {
            failure = error;
        }
    }
    throw new AudioEngineDownloadError(failure);
};

const downloadWasm = async (base: URL, cache: RequestCache): Promise<string> => {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout>;
    const touchDownload = (): void => {
        clearTimeout(timeout);
        timeout = setTimeout(() => {
            controller.abort(new DOMException("Audio engine download stopped receiving data", "TimeoutError"));
        }, downloadIdleTimeoutMs);
    };
    const readAsset = async (path: string): Promise<Blob> => {
        const response = await fetch(new URL(path, base), { cache, signal: controller.signal });
        if (!response.ok) throw new Error(`Unable to load audio engine asset (${response.status})`);
        if (!response.body) throw new Error("Audio engine download returned no data");
        const reader = response.body.getReader();
        const chunks: Uint8Array<ArrayBuffer>[] = [];
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value.byteLength > 0) {
                    touchDownload();
                    chunks.push(value as Uint8Array<ArrayBuffer>);
                }
            }
        } finally {
            reader.releaseLock();
        }
        return new Blob(chunks);
    };

    touchDownload();
    try {
        const manifestBlob = await readAsset("ffmpeg-core.wasm.manifest.json");
        const manifest = JSON.parse(await manifestBlob.text()) as WasmManifest;
        if (
            !Number.isSafeInteger(manifest.size)
            || manifest.size <= 0
            || manifest.size > maximumWasmBytes
            || !Array.isArray(manifest.parts)
            || manifest.parts.length < 2
            || manifest.parts.some((part) => !/^ffmpeg-core\.wasm\.part\d+$/.test(part))
        ) {
            throw new TypeError("Invalid FFmpeg manifest");
        }
        const chunks = await Promise.all(manifest.parts.map(readAsset));
        if (chunks.reduce((size, chunk) => size + chunk.size, 0) !== manifest.size) {
            throw new Error("Incomplete FFmpeg core download");
        }
        return URL.createObjectURL(new Blob(chunks, { type: "application/wasm" }));
    } finally {
        clearTimeout(timeout!);
        controller.abort();
    }
};
