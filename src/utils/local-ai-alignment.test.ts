import { afterEach, describe, expect, it, vi } from "vitest";
import {
    alignerChunkRequestType,
    alignerCommitRequestType,
    alignerResponseType,
    alignerResultRequestType,
    alignerStartRequestType,
    type LocalAlignerRequest,
} from "../shared/local-aligner-protocol.js";
import { mediaExtensionAckType } from "../shared/media-extension-protocol.js";
import { runLocalAiAlignment } from "./local-ai-alignment.js";

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
        const uploadId = "12345678-1234-1234-1234-123456789abc";

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
                    version: "0.4.0",
                });

                if (request.type === alignerStartRequestType) {
                    expect(request.audioName).toBe("demo.flac");
                    expect(request.transcript).toBe("One\nTwo");
                    dispatchSuccess(request.requestId, {
                        kind: "start",
                        uploadId,
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
        });

        expect(result).toBe("[00:01.234]One\n[00:02.345]Two");
        expect(received).toEqual([1, 2, 3, 4, 5]);
        expect(precision).toBe(3);
        expect(requestTypes).toEqual([
            alignerStartRequestType,
            alignerChunkRequestType,
            alignerChunkRequestType,
            alignerChunkRequestType,
            alignerCommitRequestType,
            alignerResultRequestType,
        ]);
    });
});
