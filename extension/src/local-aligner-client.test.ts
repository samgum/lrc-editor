import { describe, expect, it, vi } from "vitest";
import {
    alignerCacheClearRequestType,
    alignerCancelRequestType,
    alignerChunkRequestType,
    alignerCleanupRequestType,
    alignerCommitRequestType,
    alignerResultRequestType,
    alignerServiceStopRequestType,
    alignerStartRequestType,
    alignerStatusRequestType,
    type LocalAlignerRequest,
} from "../../src/shared/local-aligner-protocol.js";
import { LocalAlignerClient } from "./local-aligner-client.js";

const jobId = "0123456789abcdef0123456789abcdef";
const uploadIdPattern = /^[a-f0-9-]{36}$/i;

const startRequest = (): LocalAlignerRequest => ({
    type: alignerStartRequestType,
    requestId: "request-start",
    uploadId: "12345678-1234-1234-1234-123456789abc",
    audioName: "demo.flac",
    audioType: "audio/flac",
    audioSize: 4,
    transcript: "One\nTwo",
    separate: true,
    bypassCache: false,
    preserveBlankLines: true,
    wordTimingBeta: false,
    useGpuAcceleration: true,
});

describe("LocalAlignerClient", () => {
    it("discovers the service, reconstructs audio, and returns the requested precision", async () => {
        let submittedForm: FormData | undefined;
        const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
            const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
            if (url.pathname === "/openapi.json") {
                return url.port === "8765"
                    ? Response.json({ info: { title: "Lyrics Forced Aligner", version: "0.2.27" } })
                    : new Response(null, { status: 404 });
            }
            if (url.pathname === "/api/health") {
                return Response.json({ ok: true, gpu_queue: { running: 0, queued: 0 } });
            }
            if (url.pathname === "/api/lrc-editor/jobs" && init?.method === "POST") {
                submittedForm = init.body as FormData;
                return Response.json({ id: jobId, status: "queued", stage: "queued", progress: 0 });
            }
            if (url.pathname === `/api/jobs/${jobId}`) {
                return Response.json({ id: jobId, status: "complete", stage: "done", progress: 1 });
            }
            if (url.pathname === `/api/jobs/${jobId}/download/lrc2`) {
                return new Response("[00:01.23]One\n[00:02.34]Two", { status: 200 });
            }
            if (url.pathname === `/api/jobs/${jobId}/cache` && init?.method === "DELETE") {
                return Response.json({ deleted: true, reclaimed_bytes: 8192 });
            }
            return new Response(null, { status: 404 });
        });
        const client = new LocalAlignerClient(fetchMock as unknown as typeof fetch);

        const started = await client.handle(startRequest());
        expect(started).toMatchObject({ kind: "start", baseUrl: "http://127.0.0.1:8765/" });
        if (started.kind !== "start") throw new Error("Expected upload session");
        expect(started.uploadId).toMatch(uploadIdPattern);

        await client.handle({
            type: alignerChunkRequestType,
            requestId: "request-chunk",
            uploadId: started.uploadId,
            index: 0,
            data: "AQIDBA==",
        });
        const committed = await client.handle({
            type: alignerCommitRequestType,
            requestId: "request-commit",
            uploadId: started.uploadId,
        });
        expect(committed).toMatchObject({ kind: "job", job: { id: jobId, status: "queued" } });

        const audio = submittedForm?.get("audio");
        expect(audio).toBeInstanceOf(Blob);
        expect([...(new Uint8Array(await (audio as Blob).arrayBuffer()))]).toEqual([1, 2, 3, 4]);
        expect(submittedForm?.get("transcript_text")).toBe("One\nTwo");
        expect(submittedForm?.get("preserve_blank_lines")).toBe("true");
        expect(submittedForm?.get("device")).toBe("auto");

        const status = await client.handle({
            type: alignerStatusRequestType,
            requestId: "request-status",
            baseUrl: "http://127.0.0.1:8765/",
            jobId,
        });
        expect(status).toMatchObject({ kind: "job", job: { status: "complete" } });
        const result = await client.handle({
            type: alignerResultRequestType,
            requestId: "request-result",
            baseUrl: "http://127.0.0.1:8765/",
            jobId,
            precision: 2,
        });
        expect(result).toEqual({ kind: "result", lrc: "[00:01.23]One\n[00:02.34]Two" });
        const cleanup = await client.handle({
            type: alignerCleanupRequestType,
            requestId: "request-cleanup",
            baseUrl: "http://127.0.0.1:8765/",
            jobId,
        });
        expect(cleanup).toEqual({ kind: "cleanup", reclaimedBytes: 8192 });
    });

    it("uses token-authenticated controls for cancellation, cache clearing, and service stop", async () => {
        const token = "a".repeat(43);
        const controlRequests: string[] = [];
        const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
            const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
            if (url.pathname === "/openapi.json" && url.port === "8765") {
                return Response.json({ info: { title: "Lyrics Forced Aligner", version: "0.2.27" } });
            }
            if (url.pathname === "/api/lrc-editor/capabilities") {
                return Response.json({ control_token: token });
            }
            if (url.pathname === `/api/lrc-editor/jobs/${jobId}/cancel`) {
                expect(new Headers(init?.headers).get("X-LRC-Editor-Control")).toBe(token);
                controlRequests.push("cancel");
                return Response.json({ accepted: true });
            }
            if (url.pathname === "/api/lrc-editor/cache") {
                expect(init?.method).toBe("DELETE");
                expect(new Headers(init?.headers).get("X-LRC-Editor-Control")).toBe(token);
                controlRequests.push("cache");
                return Response.json({ deleted: true, reclaimed_bytes: 1024 });
            }
            if (url.pathname === "/api/lrc-editor/service/stop") {
                expect(init?.method).toBe("POST");
                expect(new Headers(init?.headers).get("X-LRC-Editor-Control")).toBe(token);
                controlRequests.push("stop");
                return Response.json({ accepted: true });
            }
            return new Response(null, { status: 404 });
        });
        const client = new LocalAlignerClient(fetchMock as unknown as typeof fetch);

        expect(
            await client.handle({
                type: alignerCancelRequestType,
                requestId: "request-cancel",
                baseUrl: "http://127.0.0.1:8765/",
                jobId,
            }),
        ).toEqual({ kind: "cancel", accepted: true });
        expect(
            await client.handle({
                type: alignerCacheClearRequestType,
                requestId: "request-cache",
            }),
        ).toEqual({ kind: "cache-clear", reclaimedBytes: 1024 });
        expect(
            await client.handle({
                type: alignerServiceStopRequestType,
                requestId: "request-stop",
            }),
        ).toEqual({ kind: "service-stop", accepted: true });
        expect(controlRequests).toEqual(["cancel", "cache", "stop"]);
    });

    it("rejects out-of-order chunks and concurrent starts", async () => {
        const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
            const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
            if (url.pathname === "/openapi.json" && url.port === "8765") {
                return Response.json({ info: { title: "Lyrics Forced Aligner", version: "0.2.27" } });
            }
            if (url.pathname === "/api/health") {
                return Response.json({ ok: true, gpu_queue: { running: 0, queued: 0 } });
            }
            return new Response(null, { status: 404 });
        });
        const client = new LocalAlignerClient(fetchMock as unknown as typeof fetch);
        const started = await client.handle(startRequest());
        if (started.kind !== "start") throw new Error("Expected upload session");

        await expect(client.handle(startRequest())).rejects.toMatchObject({ code: "ALIGNER_BUSY" });
        await expect(client.handle({
            type: alignerChunkRequestType,
            requestId: "request-chunk",
            uploadId: started.uploadId,
            index: 1,
            data: "AQIDBA==",
        })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    });

    it("does not create a second job while the local queue is occupied", async () => {
        const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
            const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
            if (url.pathname === "/openapi.json" && url.port === "8765") {
                return Response.json({ info: { title: "Lyrics Forced Aligner", version: "0.2.27" } });
            }
            if (url.pathname === "/api/health") {
                return Response.json({ ok: true, gpu_queue: { running: 1, queued: 0 } });
            }
            return new Response(null, { status: 404 });
        });
        const client = new LocalAlignerClient(fetchMock as unknown as typeof fetch);
        await expect(client.handle(startRequest())).rejects.toMatchObject({ code: "ALIGNER_BUSY" });
    });
});
