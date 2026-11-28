import { describe, expect, it, vi } from "vitest";
import {
    buildAlignmentPrompt,
    CloudAiAlignmentError,
    DEFAULT_GEMINI_MODEL,
    DEFAULT_LINE_ALIGN_PROMPT,
    DEFAULT_OPENROUTER_MODEL,
    parseCloudLineAlignment,
    parseCloudWordAlignment,
    runCloudAiAlignment,
    stripModelCodeFences,
} from "./cloud-ai-alignment.js";

const createSseResponse = (events: readonly unknown[], status = 200): Response => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            for (const event of events) {
                const line = typeof event === "string" ? event : `data: ${JSON.stringify(event)}\n\n`;
                controller.enqueue(encoder.encode(line));
            }
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
        },
    });
    return new Response(body, {
        status,
        headers: { "Content-Type": "text/event-stream" },
    });
};

describe("cloud-ai-alignment", () => {
    it("strips markdown code fences and parses strict monotonic line LRC preserving original text and blank lines", () => {
        const transcript = "First line!\n\nSecond line's text";
        const modelRaw = [
            "```lrc",
            "[00:05.120]First line!",
            "[00:05.120]",
            "[00:10.500]Second line’s text",
            "```",
        ].join("\n");

        expect(stripModelCodeFences(modelRaw)).toContain("[00:05.120]First line!");

        const parsed = parseCloudLineAlignment(modelRaw, transcript, 3);
        expect(parsed.lrc.split("\n")).toEqual([
            "[00:05.120]First line!",
            "[00:05.130]",
            "[00:10.500]Second line's text",
        ]);
        expect(parsed.lyrics.map((line) => line.text)).toEqual(["First line!", "", "Second line's text"]);
    });

    it("supports 2-digit precision and rejects line-count mismatches", () => {
        const parsed = parseCloudLineAlignment(
            "[00:01.234]Hello\n[00:03.456]World",
            "Hello\nWorld",
            2,
        );
        expect(parsed.lrc).toBe("[00:01.23]Hello\n[00:03.46]World");

        expect(() => parseCloudLineAlignment("[00:01.000]Only one line", "Line 1\nLine 2", 3)).toThrow(
            CloudAiAlignmentError,
        );
    });

    it("supports SRT output fallback and transcribe mode without original transcript", () => {
        const srtOutput = [
            "1",
            "00:00:02,500 --> 00:00:05,000",
            "Transcribed line one",
            "",
            "2",
            "00:00:06,200 --> 00:00:09,000",
            "Transcribed line two",
        ].join("\n");

        const parsed = parseCloudLineAlignment(srtOutput, "", 3);
        expect(parsed.lrc).toBe("[00:02.500]Transcribed line one\n[00:06.200]Transcribed line two");
    });

    it("parses beta word-by-word Enhanced LRC output into an AdvancedLyricsDocument", () => {
        const raw = [
            "```lrc",
            "[00:01.000]<00:01.000>你<00:01.400>好<00:01.900>",
            "[00:02.500]",
            "[00:03.000]<00:03.000>Hello <00:03.500>world<00:04.200>",
            "```",
        ].join("\n");
        const parsed = parseCloudWordAlignment(raw, "你好\n\nHello world", new Map([["ti", "Demo"]]), 3);
        expect(parsed.document.timingMode).toBe("word");
        expect(parsed.document.metadata.ti).toBe("Demo");
        expect(parsed.document.lines).toHaveLength(3);
        expect(parsed.document.lines[0].words.map((w) => w.text)).toEqual(["你", "好"]);
        expect(parsed.document.lines[0].words[0].startMs).toBe(1000);
        expect(parsed.document.lines[2].words[1].endMs).toBe(4200);
    });

    it("injects {lyrics} into default and custom prompts", () => {
        expect(buildAlignmentPrompt("line", "Line A")).toContain("Line A");
        expect(DEFAULT_LINE_ALIGN_PROMPT).toContain("{lyrics}");
        expect(buildAlignmentPrompt("line", "Line A", "Custom instructions without placeholder")).toContain("Line A");
        expect(buildAlignmentPrompt("line", "Line A", "Align:\n{lyrics}\nDone")).toBe("Align:\nLine A\nDone");
    });

    it("calls Gemini Official streaming endpoint with gemini-4-neon inline audio and parses SSE response", async () => {
        const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
            createSseResponse([
                { candidates: [{ content: { parts: [{ text: "thinking...", thought: true }] } }] },
                { candidates: [{ content: { parts: [{ text: "[00:01.200]Line one\n" }] } }] },
                { candidates: [{ content: { parts: [{ text: "[00:04.500]Line two" }] }, finishReason: "STOP" }] },
            ]),
        );

        const audio = new Blob([new Uint8Array([1, 2, 3, 4])], { type: "audio/mpeg" });
        const result = await runCloudAiAlignment({
            provider: "gemini",
            model: DEFAULT_GEMINI_MODEL,
            apiKey: "test-key",
            audio,
            audioName: "demo.mp3",
            transcript: "Line one\nLine two",
            mode: "line",
            precision: 3,
            thinking: false,
            fetchImpl: fetchMock,
        });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0];
        expect(String(url)).toContain(`/v1beta/models/${DEFAULT_GEMINI_MODEL}:streamGenerateContent?alt=sse`);
        const headers = init?.headers as Record<string, string> | undefined;
        expect(headers?.["x-goog-api-key"]).toBe("test-key");
        const sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect((sentBody.generationConfig as Record<string, unknown>).maxOutputTokens).toBe(32768);
        expect(result.lrc).toBe("[00:01.200]Line one\n[00:04.500]Line two");
    });

    it("calls OpenRouter streaming endpoint with input_audio and parses SSE response", async () => {
        const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
            createSseResponse([
                { choices: [{ delta: { content: "[00:02.000]Alpha\n" } }] },
                { choices: [{ delta: { content: "[00:05.500]Beta" }, finish_reason: "stop" }] },
            ]),
        );

        const audio = new Blob([new Uint8Array([1, 2, 3, 4])], { type: "audio/mpeg" });
        const result = await runCloudAiAlignment({
            provider: "openrouter",
            model: DEFAULT_OPENROUTER_MODEL,
            apiKey: "test-or-key",
            audio,
            audioName: "demo.mp3",
            transcript: "Alpha\nBeta",
            mode: "line",
            precision: 3,
            thinking: false,
            fetchImpl: fetchMock,
        });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0];
        expect(String(url)).toBe("https://openrouter.ai/api/v1/chat/completions");
        const headers = init?.headers as Record<string, string> | undefined;
        expect(headers?.Authorization).toBe("Bearer test-or-key");
        const sentBody = JSON.parse(String(init?.body)) as {
            model: string;
            max_tokens: number;
            messages: { content: { type: string; input_audio?: { format: string } }[] }[];
        };
        expect(sentBody.model).toBe(DEFAULT_OPENROUTER_MODEL);
        expect(sentBody.max_tokens).toBe(8192);
        expect(sentBody.messages[0].content[0].type).toBe("input_audio");
        expect(sentBody.messages[0].content[0].input_audio?.format).toBe("mp3");
        expect(result.lrc).toBe("[00:02.000]Alpha\n[00:05.500]Beta");
    });
});
