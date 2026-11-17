import { describe, expect, it } from "vitest";
import { isExpectedOfflineResponse, isSafeOfflineAssetPath } from "./offline-cache.js";

describe("offline cache validation", () => {
    it("accepts generated same-origin asset paths only", () => {
        expect(isSafeOfflineAssetPath("assets/index-abc123.js")).toBe(true);
        expect(isSafeOfflineAssetPath("../secret.txt")).toBe(false);
        expect(isSafeOfflineAssetPath("https://example.com/file.js")).toBe(false);
    });

    it("rejects an HTML fallback served for a missing script", () => {
        const script = new URL("https://lrc.sgmy.org/assets/index.js");
        expect(isExpectedOfflineResponse(
            script,
            new Response("html", {
                status: 200,
                headers: { "Content-Type": "text/html" },
            }),
        )).toBe(false);
        expect(isExpectedOfflineResponse(
            script,
            new Response("js", {
                status: 200,
                headers: { "Content-Type": "application/javascript" },
            }),
        )).toBe(true);
    });

    it("accepts the cached navigation shell on root and subpath deployments", () => {
        expect(isExpectedOfflineResponse(
            new URL("https://lrc.sgmy.org/"),
            new Response("html", {
                status: 200,
                headers: { "Content-Type": "text/html; charset=utf-8" },
            }),
        )).toBe(true);
        expect(isExpectedOfflineResponse(
            new URL("https://samgum.github.io/lrc-editor/"),
            new Response("html", {
                status: 200,
                headers: { "Content-Type": "text/html; charset=utf-8" },
            }),
        )).toBe(true);
    });
});
