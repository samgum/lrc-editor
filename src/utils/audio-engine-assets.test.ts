import { afterEach, describe, expect, it, vi } from "vitest";
import { AudioEngineDownloadError, loadAudioEngineWasmUrl } from "./audio-engine-assets.js";

const base = new URL("https://example.test/ffmpeg/");
const manifest = { size: 8, parts: ["ffmpeg-core.wasm.part0", "ffmpeg-core.wasm.part1"] };

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("audio engine downloads", () => {
    it("allows a download taking more than 30 seconds while bytes keep arriving", async () => {
        vi.useFakeTimers();
        let assembled: Blob | undefined;
        vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
            assembled = blob as Blob;
            return "blob:wasm";
        });
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: URL, options: RequestInit) => {
                if (url.pathname.endsWith(".json")) return Response.json(manifest);
                let sent = 0;
                let closed = false;
                return new Response(
                    new ReadableStream({
                        start(controller) {
                            const timer = setInterval(() => {
                                controller.enqueue(new Uint8Array([0, 1]));
                                if (++sent === 2) {
                                    closed = true;
                                    clearInterval(timer);
                                    controller.close();
                                }
                            }, 20_000);
                            options.signal?.addEventListener("abort", () => {
                                clearInterval(timer);
                                if (!closed) controller.error(options.signal?.reason);
                            });
                        },
                    }),
                );
            }),
        );
        const download = loadAudioEngineWasmUrl(base);
        await vi.advanceTimersByTimeAsync(40_001);
        await expect(download).resolves.toBe("blob:wasm");
        expect(assembled?.size).toBe(8);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("retries one transient failure using fresh assets and cancels the first attempt", async () => {
        const signals: AbortSignal[] = [];
        const policies: RequestCache[] = [];
        let manifestRequests = 0;
        vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:wasm");
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: URL, options: RequestInit) => {
                signals.push(options.signal as AbortSignal);
                policies.push(options.cache!);
                if (url.pathname.endsWith(".json")) {
                    manifestRequests++;
                    return Response.json(manifest);
                }
                if (manifestRequests === 1) return new Response("Temporary failure", { status: 503 });
                return new Response(new Uint8Array(4));
            }),
        );
        await expect(loadAudioEngineWasmUrl(base)).resolves.toBe("blob:wasm");
        expect(manifestRequests).toBe(2);
        expect(policies).toContain("force-cache");
        expect(policies).toContain("reload");
        expect(signals.every((signal) => signal.aborted)).toBe(true);
    });

    it("stops genuinely stalled requests, retries once, and reports a download error", async () => {
        vi.useFakeTimers();
        const signals: AbortSignal[] = [];
        vi.stubGlobal(
            "fetch",
            vi.fn((_url: URL, options: RequestInit) => {
                const signal = options.signal as AbortSignal;
                signals.push(signal);
                return new Promise((_resolve, reject) => {
                    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
                });
            }),
        );
        const failure = loadAudioEngineWasmUrl(base).catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(60_001);
        const error = await failure;
        expect(error).toBeInstanceOf(AudioEngineDownloadError);
        expect((error as AudioEngineDownloadError).cause).toBeInstanceOf(DOMException);
        expect(signals).toHaveLength(2);
        expect(signals.every((signal) => signal.aborted)).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("rejects truncated chunks without creating a partial WebAssembly URL", async () => {
        const createUrl = vi.spyOn(URL, "createObjectURL");
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: URL) =>
                url.pathname.endsWith(".json") ? Response.json(manifest) : new Response(new Uint8Array(2))
            ),
        );
        await expect(loadAudioEngineWasmUrl(base)).rejects.toBeInstanceOf(AudioEngineDownloadError);
        expect(createUrl).not.toHaveBeenCalled();
    });
});
