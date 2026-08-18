import { afterEach, describe, expect, it, vi } from "vitest";
import {
    alignerCancelRequestType,
    alignerChunkRequestType,
    alignerCleanupRequestType,
    alignerCommitRequestType,
    alignerResponseType,
    alignerResultRequestType,
    alignerStartRequestType,
    type LocalAlignerRequest,
} from "../shared/local-aligner-protocol.js";
import { mediaExtensionAckType } from "../shared/media-extension-protocol.js";
import { ProgressEtaEstimator, runLocalAiAlignment } from "./local-ai-alignment.js";

describe("local AI alignment page bridge", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("streams the current media in order and requests the selected precision", async () => {
        const events = new EventTarget();
        const received: number[] = [];
        const requestTypes: string[] = [];
        let precision = 0;
        const jobId = "0123456789abcdef0123456789abcdef";

        const windowStub = {
            addEventListener: events.addEventListener.bind(events),
            removeEventListener: events.removeEventListener.bind(events),
            setTimeout,
            clearTimeout,
            postMessage: (request: LocalAlignerRequest): void => {
                requestTypes.push(request.type);
                dispatch({
                    type: mediaExtensionAckType,
                    requestId: request.requestId,
                    version: "0.4.5",
                });

                if (request.type === alignerStartRequestType) {
                    expect(request.uploadId).toMatch(/^[a-f0-9-]{36}$/i);
                    expect(request.audioName).toBe("demo.flac");
                    expect(request.transcript).toBe("One\nTwo");
                    expect(request.bypassCache).toBe(true);
                    expect(request.useGpuAcceleration).toBe(true);
                    dispatchSuccess(request.requestId, {
                        kind: "start",
                        uploadId: request.uploadId,
                        baseUrl: "http://127.0.0.1:8765/",
                        chunkSize: 2,
                        serviceVersion: "0.2.27",
                    });
                } else if (request.type === alignerChunkRequestType) {
                    const binary = atob(request.data);
                    for (let index = 0; index < binary.length; index += 1) {
                        received.push(binary.charCodeAt(index));
                    }
                    dispatchSuccess(request.requestId, { kind: "chunk", received: received.length });
                } else if (request.type === alignerCommitRequestType) {
                    dispatchSuccess(request.requestId, {
                        kind: "job",
                        baseUrl: "http://127.0.0.1:8765/",
                        job: { id: jobId, status: "complete", stage: "done", progress: 1 },
                    });
                } else if (request.type === alignerResultRequestType) {
                    precision = request.precision;
                    dispatchSuccess(request.requestId, { kind: "result", lrc: "[00:01.234]One\n[00:02.345]Two" });
                } else if (request.type === alignerCleanupRequestType) {
                    dispatchSuccess(request.requestId, { kind: "cleanup", reclaimedBytes: 4096 });
                }
            },
        };

        const dispatch = (data: unknown): void => {
            const event = new Event("message");
            Object.defineProperties(event, {
                source: { value: windowStub },
                origin: { value: "https://lrc.sgmy.org" },
                data: { value: data },
            });
            events.dispatchEvent(event);
        };
        const dispatchSuccess = (requestId: string, payload: unknown): void => {
            dispatch({ type: alignerResponseType, requestId, ok: true, payload });
        };

        vi.stubGlobal("location", { origin: "https://lrc.sgmy.org" });
        vi.stubGlobal("window", windowStub);

        const result = await runLocalAiAlignment({
            audio: new Blob([new Uint8Array([1, 2, 3, 4, 5])], { type: "audio/flac" }),
            audioName: "demo.flac",
            transcript: "One\nTwo",
            precision: 3,
            keepTaskCache: false,
            useGpuAcceleration: true,
        });

        expect(result).toEqual({
            lrc: "[00:01.234]One\n[00:02.345]Two",
            cacheCleanup: "deleted",
            reclaimedBytes: 4096,
        });
        expect(received).toEqual([1, 2, 3, 4, 5]);
        expect(precision).toBe(3);
        expect(requestTypes).toEqual([
            alignerStartRequestType,
            alignerChunkRequestType,
            alignerChunkRequestType,
            alignerChunkRequestType,
            alignerCommitRequestType,
            alignerResultRequestType,
            alignerCleanupRequestType,
        ]);
    });

    it("cancels the active local job when the page aborts", async () => {
        const events = new EventTarget();
        const controller = new AbortController();
        const jobId = "0123456789abcdef0123456789abcdef";
        let cancelCount = 0;

        const windowStub = {
            addEventListener: events.addEventListener.bind(events),
            removeEventListener: events.removeEventListener.bind(events),
            setTimeout,
            clearTimeout,
            postMessage: (request: LocalAlignerRequest): void => {
                dispatch({
                    type: mediaExtensionAckType,
                    requestId: request.requestId,
                    version: "0.4.5",
                });
                if (request.type === alignerStartRequestType) {
                    dispatchSuccess(request.requestId, {
                        kind: "start",
                        uploadId: request.uploadId,
                        baseUrl: "http://127.0.0.1:8765/",
                        chunkSize: 16,
                        serviceVersion: "0.2.27",
                    });
                } else if (request.type === alignerChunkRequestType) {
                    dispatchSuccess(request.requestId, { kind: "chunk", received: 4 });
                } else if (request.type === alignerCommitRequestType) {
                    dispatchSuccess(request.requestId, {
                        kind: "job",
                        baseUrl: "http://127.0.0.1:8765/",
                        job: { id: jobId, status: "running", stage: "recognize", progress: 0.4 },
                    });
                } else if (request.type === alignerCancelRequestType) {
                    cancelCount += 1;
                    expect("jobId" in request && request.jobId).toBe(jobId);
                    dispatchSuccess(request.requestId, { kind: "cancel", accepted: true });
                }
            },
        };
        const dispatch = (data: unknown): void => {
            const event = new Event("message");
            Object.defineProperties(event, {
                source: { value: windowStub },
                origin: { value: "https://lrc.sgmy.org" },
                data: { value: data },
            });
            events.dispatchEvent(event);
        };
        const dispatchSuccess = (requestId: string, payload: unknown): void => {
            dispatch({ type: alignerResponseType, requestId, ok: true, payload });
        };

        vi.stubGlobal("location", { origin: "https://lrc.sgmy.org" });
        vi.stubGlobal("window", windowStub);

        await expect(runLocalAiAlignment({
            audio: new Blob([new Uint8Array([1, 2, 3, 4])], { type: "audio/flac" }),
            audioName: "demo.flac",
            transcript: "One",
            precision: 3,
            keepTaskCache: false,
            useGpuAcceleration: false,
            signal: controller.signal,
            onProgress: (progress) => {
                if (progress.phase === "running") controller.abort();
            },
        })).rejects.toMatchObject({ code: "cancelled" });
        expect(cancelCount).toBe(1);
    });

    it("stops before uploading media when the mobile bridge responds", async () => {
        const events = new EventTarget();
        let requestCount = 0;
        const windowStub = {
            addEventListener: events.addEventListener.bind(events),
            removeEventListener: events.removeEventListener.bind(events),
            setTimeout,
            clearTimeout,
            postMessage: (request: LocalAlignerRequest): void => {
                requestCount += 1;
                const event = new Event("message");
                Object.defineProperties(event, {
                    source: { value: windowStub },
                    origin: { value: "https://samgum.github.io" },
                    data: {
                        value: {
                            type: mediaExtensionAckType,
                            requestId: request.requestId,
                            version: "0.4.6",
                            mobile: true,
                        },
                    },
                });
                events.dispatchEvent(event);
            },
        };
        vi.stubGlobal("location", { origin: "https://samgum.github.io" });
        vi.stubGlobal("window", windowStub);

        await expect(runLocalAiAlignment({
            audio: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/mp4" }),
            audioName: "mobile.m4a",
            transcript: "One",
            precision: 3,
            keepTaskCache: false,
            useGpuAcceleration: false,
        })).rejects.toMatchObject({ code: "mobile" });
        expect(requestCount).toBe(1);
    });

    it("estimates remaining time from lightweight progress samples", () => {
        let now = 0;
        const estimator = new ProgressEtaEstimator(() => now);
        expect(estimator.update(0.1)).toBeUndefined();
        now = 5_000;
        expect(estimator.update(0.2)).toBe(40);
        now = 10_000;
        expect(estimator.update(0.3)).toBe(39);
    });
});
