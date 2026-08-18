import { describe, expect, it } from "vitest";
import {
    alignerChunkRequestType,
    alignerResultRequestType,
    alignerStartRequestType,
    isLocalAlignerBaseUrl,
    isLocalAlignerRequest,
} from "./local-aligner-protocol.js";

describe("local aligner protocol", () => {
    it("accepts bounded start and chunk requests", () => {
        expect(isLocalAlignerRequest({
            type: alignerStartRequestType,
            requestId: "request-123",
            audioName: "song.flac",
            audioType: "audio/flac",
            audioSize: 4,
            transcript: "One\nTwo",
            separate: true,
            bypassCache: false,
            preserveBlankLines: true,
            wordTimingBeta: false,
        })).toBe(true);
        expect(isLocalAlignerRequest({
            type: alignerChunkRequestType,
            requestId: "request-456",
            uploadId: "12345678-1234-1234-1234-123456789abc",
            index: 0,
            data: "AQIDBA==",
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
