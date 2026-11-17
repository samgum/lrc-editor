import { FFmpeg } from "@ffmpeg/ffmpeg";
import ffmpegWorkerURL from "@ffmpeg/ffmpeg/worker?worker&url";
import { loadAudioEngineWasmUrl } from "./audio-engine-assets.js";
import { randomId } from "./random-id.js";

const maximumInputBytes = 512 * 1024 * 1024;

export const transcodeAudioForBrowser = async (
    file: File,
    onProgress?: (progress: number) => void,
): Promise<Blob> => {
    if (file.size > maximumInputBytes) {
        throw new RangeError("The media file is too large for in-browser conversion");
    }

    const ffmpeg = await createFFmpeg();
    const id = randomId();
    const extension = /\.([A-Za-z0-9]{1,8})$/.exec(file.name)?.[1].toLowerCase() || "bin";
    const inputName = `input-${id}.${extension}`;
    const outputName = `output-${id}.m4a`;
    const progressListener = ({ progress }: { progress: number }): void =>
        onProgress?.(Math.max(0, Math.min(1, progress)));

    ffmpeg.on("progress", progressListener);
    try {
        await ffmpeg.writeFile(inputName, new Uint8Array(await file.arrayBuffer()));
        const exitCode = await ffmpeg.exec(createAacTranscodeArguments(inputName, outputName), 60_000);
        if (exitCode !== 0) {
            throw new Error(`Audio conversion failed with exit code ${exitCode}`);
        }
        const data = await ffmpeg.readFile(outputName);
        if (!(data instanceof Uint8Array)) {
            throw new TypeError("Audio conversion returned unexpected data");
        }
        return new Blob([data as Uint8Array<ArrayBuffer>], {
            type: "audio/mp4",
        });
    } finally {
        ffmpeg.off("progress", progressListener);
        await disposeAudioTranscoder(ffmpeg, [inputName, outputName]);
    }
};

export const createAacTranscodeArguments = (inputName: string, outputName: string): string[] => [
    "-i",
    inputName,
    "-map",
    "0:a:0",
    "-vn",
    "-map_metadata",
    "-1",
    "-c:a",
    "aac",
    "-b:a",
    "256k",
    "-movflags",
    "+faststart",
    outputName,
];

interface DisposableAudioTranscoder {
    deleteFile(path: string): Promise<boolean>;
    terminate(): void;
}

export const disposeAudioTranscoder = async (
    ffmpeg: DisposableAudioTranscoder,
    temporaryFiles: readonly string[],
): Promise<void> => {
    try {
        await Promise.allSettled(temporaryFiles.map((path) => ffmpeg.deleteFile(path)));
    } finally {
        ffmpeg.terminate();
    }
};

const createFFmpeg = async (): Promise<FFmpeg> => {
    const ffmpeg = new FFmpeg();
    const base = new URL("ffmpeg/", document.baseURI);
    const wasmURL = await loadAudioEngineWasmUrl(base);
    try {
        await withTimeout(
            ffmpeg.load({
                classWorkerURL: ffmpegWorkerURL,
                coreURL: new URL("ffmpeg-core.js", base).href,
                wasmURL,
            }),
            30_000,
        );
    } catch (error) {
        ffmpeg.terminate();
        throw error;
    } finally {
        URL.revokeObjectURL(wasmURL);
    }
    return ffmpeg;
};

const withTimeout = <T>(promise: Promise<T>, timeoutMs: number): Promise<T> =>
    new Promise((resolve, reject) => {
        const timeout = window.setTimeout(() => reject(new Error("FFmpeg core loading timed out")), timeoutMs);
        promise.then(
            (value) => {
                window.clearTimeout(timeout);
                resolve(value);
            },
            (error: unknown) => {
                window.clearTimeout(timeout);
                reject(error);
            },
        );
    });
