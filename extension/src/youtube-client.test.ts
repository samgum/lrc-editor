import { describe, expect, it, vi } from "vitest";
import {
    createYouTubeFetch,
    decodeYouTubeRequestBody,
    readYouTubePlaybackContext,
    updateYouTubePlayerBody,
    youtubeAudioClients,
    youtubeClientRevision,
    youtubePlayerToken,
} from "./youtube-client.js";

const videoId = "78wrful9cVU";
const body = JSON.stringify({
    videoId,
    context: {
        client: { clientName: "WEB_EMBEDDED_PLAYER", clientVersion: "2.20260903.01.00", visitorData: "test-visitor" },
    },
    serviceIntegrityDimensions: { poToken: "test-token" },
});

describe("YouTube client maintenance", () => {
    it("uses the maintained clients without retired Android VR and TV-embedded fallbacks", () => {
        expect(youtubeClientRevision).toBe("yt-dlp-2026.08.19");
        expect(youtubeAudioClients).toEqual(["VISIONOS", "WEB_EMBEDDED", "WEB", "MWEB"]);
    });

    it("accepts only the requested video's fresh playback context", () => {
        expect(readYouTubePlaybackContext(body, videoId)).toEqual({
            videoId,
            visitorData: "test-visitor",
            poToken: "test-token",
            embeddedClientVersion: "2.20260903.01.00",
        });
        expect(readYouTubePlaybackContext(body, "60rlboK94mE")).toBeNull();
        expect(readYouTubePlaybackContext("invalid", videoId)).toBeNull();
        expect(readYouTubePlaybackContext(JSON.stringify({ videoId }), videoId)).toBeNull();
    });

    it("does not require a token when the browser supplies a usable visitor context", () => {
        const payload = JSON.parse(body);
        delete payload.serviceIntegrityDimensions;
        expect(readYouTubePlaybackContext(JSON.stringify(payload), videoId)).toMatchObject({
            videoId,
            visitorData: "test-visitor",
            poToken: undefined,
        });
    });

    it("never reuses a video-bound web player token for another video or native client", () => {
        const context = readYouTubePlaybackContext(body, videoId);
        expect(youtubePlayerToken(context, videoId, "WEB_EMBEDDED")).toBe("test-token");
        expect(youtubePlayerToken(context, "60rlboK94mE", "WEB_EMBEDDED")).toBeUndefined();
        expect(youtubePlayerToken(context, videoId, "VISIONOS")).toBeUndefined();
    });

    it("refreshes the embedded client version from the actual player, with a pinned offline fallback", () => {
        const context = readYouTubePlaybackContext(body, videoId);
        const current = updateYouTubePlayerBody(body, "https://lrc.sgmy.org/", context);
        expect(current.clientVersion).toBe("2.20260903.01.00");
        expect(JSON.parse(current.body).context.thirdParty.embedUrl).toBe("https://lrc.sgmy.org/");
        expect(updateYouTubePlayerBody(body, "https://lrc.sgmy.org/", null).clientVersion).toBe("2.20260708.00.00");
        expect(JSON.parse(body).context.thirdParty).toBeUndefined();
    });

    it("keeps request headers and body in sync and sends no account cookies", async () => {
        const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}"));
        const request = createYouTubeFetch("https://lrc.sgmy.org/", readYouTubePlaybackContext(body, videoId), fetcher);
        await request("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
            method: "POST",
            body,
            credentials: "include",
            headers: { Cookie: "test-cookie", Authorization: "test-auth", "Content-Type": "application/json" },
        });
        const options = fetcher.mock.calls[0][1]!;
        const headers = new Headers(options.headers);
        expect(options.credentials).toBe("omit");
        expect(options.cache).toBe("no-store");
        expect(headers.has("Cookie")).toBe(false);
        expect(headers.has("Authorization")).toBe(false);
        expect(headers.get("X-Youtube-Client-Version")).toBe("2.20260903.01.00");
    });

    it("does not rewrite unrelated requests or external hosts", async () => {
        const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}"));
        const request = createYouTubeFetch("https://lrc.sgmy.org/", null, fetcher);
        await request("https://example.org/youtubei/v1/player", { method: "POST", body });
        expect(fetcher.mock.calls[0][1]?.body).toBe(body);
    });
});

describe("YouTube player request decoding", () => {
    it("joins raw upload parts before decoding UTF-8", async () => {
        const bytes = new TextEncoder().encode("日本語");
        expect(
            await decodeYouTubeRequestBody([
                { bytes: bytes.slice(0, 2).buffer },
                { bytes: bytes.slice(2).buffer },
            ]),
        ).toBe("日本語");
    });

    it("reads gzip-compressed player requests without logging their content", async () => {
        const compressed = await new Response(new Blob([body]).stream().pipeThrough(new CompressionStream("gzip")))
            .arrayBuffer();
        const decoded = await decodeYouTubeRequestBody([{ bytes: compressed }]);
        expect(decoded).toBe(body);
        expect(readYouTubePlaybackContext(decoded!, videoId)?.poToken).toBe("test-token");
    });

    it("rejects empty, malformed gzip and oversized decompressed bodies", async () => {
        expect(await decodeYouTubeRequestBody([])).toBeNull();
        expect(await decodeYouTubeRequestBody([{ bytes: new Uint8Array([31, 139, 0]).buffer }])).toBeNull();
        const compressed = await new Response(
            new Blob(["a".repeat(1_048_577)]).stream().pipeThrough(new CompressionStream("gzip")),
        ).arrayBuffer();
        expect(await decodeYouTubeRequestBody([{ bytes: compressed }])).toBeNull();
    });
});
