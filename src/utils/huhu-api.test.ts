import { afterEach, describe, expect, it, vi } from "vitest";
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
