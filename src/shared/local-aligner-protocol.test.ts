import { describe, expect, it } from "vitest";
import {
    alignerCacheClearRequestType,
    alignerCancelRequestType,
    alignerChunkRequestType,
    alignerResultRequestType,
    alignerServiceStopRequestType,
    alignerStartRequestType,
    isLocalAlignerBaseUrl,
    isLocalAlignerRequest,
} from "./local-aligner-protocol.js";

describe("local aligner protocol", () => {
    it("accepts bounded start and chunk requests", () => {
        expect(isLocalAlignerRequest({
            type: alignerStartRequestType,
            requestId: "request-123",
            uploadId: "12345678-1234-1234-1234-123456789abc",
            audioName: "song.flac",
            audioType: "audio/flac",
            audioSize: 4,
            transcript: "One\nTwo",
            separate: true,
            bypassCache: false,
            preserveBlankLines: true,
            wordTimingBeta: false,
            useGpuAcceleration: true,
        })).toBe(true);
        expect(isLocalAlignerRequest({
            type: alignerChunkRequestType,
            requestId: "request-456",
            uploadId: "12345678-1234-1234-1234-123456789abc",
            index: 0,
            data: "AQIDBA==",
        })).toBe(true);
    });

    it("accepts scoped upload, job, service, and cache controls", () => {
        expect(isLocalAlignerRequest({
            type: alignerCancelRequestType,
            requestId: "request-upload-cancel",
            uploadId: "12345678-1234-1234-1234-123456789abc",
        })).toBe(true);
        expect(isLocalAlignerRequest({
            type: alignerCancelRequestType,
            requestId: "request-job-cancel",
            baseUrl: "http://127.0.0.1:8765/",
            jobId: "0123456789abcdef0123456789abcdef",
        })).toBe(true);
        expect(isLocalAlignerRequest({
            type: alignerServiceStopRequestType,
            requestId: "request-service-stop",
        })).toBe(true);
        expect(isLocalAlignerRequest({
            type: alignerCacheClearRequestType,
            requestId: "request-cache-clear",
        })).toBe(true);
    });

    it("only permits the fixed loopback service ports", () => {
        expect(isLocalAlignerBaseUrl("http://127.0.0.1:8765/")).toBe(true);
        expect(isLocalAlignerBaseUrl("http://127.0.0.1:8895/")).toBe(true);
        expect(isLocalAlignerBaseUrl("http://localhost:8765/")).toBe(false);
        expect(isLocalAlignerBaseUrl("https://127.0.0.1:8765/")).toBe(false);
        expect(isLocalAlignerBaseUrl("http://127.0.0.1:9000/")).toBe(false);
    });

    it("rejects result requests that could target another local service", () => {
        expect(isLocalAlignerRequest({
            type: alignerResultRequestType,
            requestId: "request-789",
            baseUrl: "http://127.0.0.1:9000/",
            jobId: "0123456789abcdef0123456789abcdef",
            precision: 3,
        })).toBe(false);
    });
});
