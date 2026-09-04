import { parser, stringify } from "@lrc-maker/lrc-parser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateAlignedLyrics, validateHuhuAlignedLyrics } from "./ai-alignment-result.js";
import {
    checkHuhuAlignmentCapability,
    huhuApiBaseUrl,
    HuhuApiError,
    isHuhuBrowserOriginAllowed,
    runHuhuAlignment,
} from "./huhu-api.js";

const jsonResponse = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("Huhu AI browser client", () => {
    it("enables the Beta on the allowed main origin, not the GitHub Pages backup", () => {
        expect(isHuhuBrowserOriginAllowed("https://lrc.sgmy.org")).toBe(true);
        expect(isHuhuBrowserOriginAllowed("https://samgum.github.io")).toBe(false);
    });

    it("checks alignment permission and quota without cookies", async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
            permission: { available: true, reason: null },
            quota: {
                periods: {
                    cycle: {
                        metrics: {
                            requests: { used: 2, pending: 1, limit: 10, remaining: 7 },
                        },
                    },
                },
            },
        }));
        vi.stubGlobal("fetch", fetchMock);

        await expect(checkHuhuAlignmentCapability("test-key")).resolves.toEqual({
            available: true,
            cycleRequests: { used: 2, pending: 1, limit: 10, remaining: 7 },
        });
        expect(fetchMock).toHaveBeenCalledWith(
            `${huhuApiBaseUrl}/capabilities/alignment`,
            expect.objectContaining({
                cache: "no-store",
                credentials: "omit",
                headers: expect.objectContaining({ Authorization: "Bearer test-key" }),
                referrerPolicy: "no-referrer",
            }),
        );
    });

    it("uploads the current media and lyrics, then downloads completed LRC", async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(jsonResponse({ permission: { available: true }, quota: {} }))
            .mockResolvedValueOnce(jsonResponse({ job: { id: "job-1", status: "completed" } }, 202))
            .mockResolvedValueOnce(new Response("[00:01.000]Line one", { status: 200 }));
        vi.stubGlobal("fetch", fetchMock);
        const progress: string[] = [];

        await expect(runHuhuAlignment({
            apiKey: "test-key",
            audio: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/mpeg" }),
            audioName: "track.mp3",
            transcript: "Line one",
            language: "en",
            onProgress: (state) => progress.push(state.phase),
        })).resolves.toBe("[00:01.000]Line one");

        const upload = fetchMock.mock.calls[1];
        const form = (upload[1] as RequestInit).body as FormData;
        expect(upload[0]).toBe(`${huhuApiBaseUrl}/alignment`);
        expect(form.get("lyrics")).toBe("Line one");
        expect(form.get("language")).toBe("en");
        expect((form.get("audio") as File).name).toBe("track.mp3");
        expect(progress).toEqual(["connecting", "uploading", "downloading", "complete"]);
    });

    it("reports browser CORS or network blocking without exposing the key", async () => {
        vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
        const error = await checkHuhuAlignmentCapability("private-test-key").catch((reason: unknown) => reason);
        expect(error).toBeInstanceOf(HuhuApiError);
        expect((error as HuhuApiError).code).toBe("cors");
        expect((error as Error).message).not.toContain("private-test-key");
    });

    it.each([
        ["This isn't gonna work, I know", "en"],
        ["君にstay\n君にlove\n君にkiss", "ja-en"],
        ["爱着你\nHello world\n与你stay", "zh-hans-cn"],
    ])("resolves auto locally before uploading %s", async (transcript, language) => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(jsonResponse({ permission: { available: true }, quota: {} }))
            .mockResolvedValueOnce(jsonResponse({ job: { id: "auto-language", status: "completed" } }, 202))
            .mockResolvedValueOnce(new Response("[00:01.000]Result", { status: 200 }));
        vi.stubGlobal("fetch", fetchMock);
        await runHuhuAlignment({
            apiKey: "test-key",
            audio: new Blob(["test media"], { type: "audio/mp4" }),
            audioName: "CLICK - JISOO.m4a",
            transcript,
            language: "auto",
        });
        const form = fetchMock.mock.calls[1][1].body as FormData;
        expect(form.get("language")).toBe(language);
        expect(form.get("lyrics")).toBe(transcript);
        expect((form.get("audio") as File).name).toBe("CLICK - JISOO.m4a");
    });

    it.each([2, 3] as const)("accepts the completed 48-line regression result at precision %i", async (precision) => {
        const times = [
            0.371,
            4.176,
            8.101,
            11.766,
            14.471,
            15.953,
            20.118,
            24.624,
            28.269,
            32.016,
            35.921,
            39.165,
            39.746,
            44.774,
            47.397,
            52.444,
            54.185,
            54.146,
            57.893,
            61.658,
            65.603,
            68.186,
            69.708,
            73.875,
            78.381,
            82.026,
            85.793,
            89.678,
            92.922,
            93.503,
            98.531,
            101.154,
            106.201,
            108.284,
            109.365,
            111.989,
            117.037,
            119.460,
            124.226,
            124.247,
            129.255,
            131.838,
            136.945,
            138.988,
            139.829,
            143.455,
            147.240,
            151.145,
        ];
        const blankIndexes = new Set([4, 11, 16, 21, 28, 33, 38, 43]);
        const lyrics = times.map((time, index) => ({
            time,
            text: blankIndexes.has(index) ? "" : `Lyric ${index + 1}`,
        }));
        const format = { fixed: 3, spaceStart: 0, spaceEnd: 0 } as const;
        const completedResult = stringify({ lyric: lyrics, info: new Map() }, format);
        const parsedOriginal = parser(completedResult).lyric;
        const transcript = lyrics.map((line) => line.text).join("\n");
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(jsonResponse({ permission: { available: true }, quota: {} }))
            .mockResolvedValueOnce(jsonResponse({ job: { id: "completed-regression", status: "completed" } }, 202))
            .mockResolvedValueOnce(new Response(completedResult, { status: 200 }));
        vi.stubGlobal("fetch", fetchMock);

        const result = await runHuhuAlignment({
            apiKey: "test-key",
            audio: new Blob(["test media"], { type: "audio/mp4" }),
            audioName: "youtube-extension-audio.m4a",
            transcript,
            language: "en",
        });
        expect(() => validateAlignedLyrics(transcript, result, {})).toThrow("AI_ALIGNMENT_DUPLICATE_TIME");
        const repaired = validateHuhuAlignedLyrics(transcript, result, {}, precision);
        expect(repaired).toHaveLength(48);
        expect(repaired.map((line) => line.text)).toEqual(lyrics.map((line) => line.text));
        expect(repaired.filter((line) => line.text).map((line) => line.time)).toEqual(
            parsedOriginal.filter((line) => line.text).map((line) => line.time),
        );
        expect(repaired.filter((line, index) => line.time !== parsedOriginal[index].time)).toHaveLength(1);
        expect(() =>
            validateAlignedLyrics(
                transcript,
                stringify({ lyric: repaired, info: new Map() }, { ...format, fixed: precision }),
                {},
            )
        ).not.toThrow();
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("stops before upload when alignment permission or quota is unavailable", async () => {
        const deniedFetch = vi.fn().mockResolvedValue(jsonResponse({
            permission: { available: false, reason: "api_key_scope_denied" },
            quota: null,
        }));
        vi.stubGlobal("fetch", deniedFetch);
        const denied = await runHuhuAlignment({
            apiKey: "test-key",
            audio: new Blob(["audio"]),
            audioName: "track.mp3",
            transcript: "Line",
            language: "en",
        }).catch((reason: unknown) => reason);
        expect(denied).toBeInstanceOf(HuhuApiError);
        expect((denied as HuhuApiError).code).toBe("denied");
        expect(deniedFetch).toHaveBeenCalledTimes(1);
    });

    it("cancels the owned remote job when the user stops alignment", async () => {
        const controller = new AbortController();
        const fetchMock = vi.fn().mockImplementation((input: string, init?: RequestInit) => {
            if (input.endsWith("/capabilities/alignment")) {
                return Promise.resolve(jsonResponse({ permission: { available: true }, quota: {} }));
            }
            if (input.endsWith("/alignment")) {
                return Promise.resolve(jsonResponse({ job: { id: "job-cancel", status: "queued" } }, 202));
            }
            if (input.endsWith("/jobs/job-cancel/cancel") && init?.method === "POST") {
                return Promise.resolve(jsonResponse({ id: "job-cancel", status: "cancelled" }));
            }
            return Promise.resolve(jsonResponse({}, 404));
        });
        vi.stubGlobal("fetch", fetchMock);

        const result = await runHuhuAlignment({
            apiKey: "test-key",
            audio: new Blob(["audio"]),
            audioName: "track.mp3",
            transcript: "Line",
            language: "en",
            signal: controller.signal,
            onProgress: (state) => {
                if (state.phase === "queued") controller.abort();
            },
        }).catch((reason: unknown) => reason);

        expect(result).toBeInstanceOf(HuhuApiError);
        expect((result as HuhuApiError).code).toBe("cancelled");
        expect(
            fetchMock.mock.calls.some(([url, init]) =>
                String(url).endsWith("/jobs/job-cancel/cancel") && (init as RequestInit).method === "POST"
            ),
        ).toBe(true);
    });
});
