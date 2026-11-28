import { type ILyric, parser, type TrimOptios } from "@lrc-maker/lrc-parser";
import {
    type AdvancedLyricLine,
    type AdvancedLyricsDocument,
    documentToBasicLyrics,
    formatLrcTimestamp,
    hasWordTiming,
    lineText,
    parseEnhancedLrc,
    parseFlexibleTimestamp,
    type TimedWord,
} from "./advanced-lyrics.js";
import { type CloudAiProvider, loadEncryptedApiKey } from "./ai-key-vault.js";
import type { LocalAlignmentProgress } from "./local-ai-alignment.js";

export type AiEngineMode = "cloud" | "local";
export type CloudAiTaskMode = "line" | "transcribe" | "word-beta";

export interface CloudAiModelOption {
    readonly id: string;
    readonly label: string;
}

export const DEFAULT_GEMINI_MODEL = "gemini-4-neon";
export const DEFAULT_OPENROUTER_MODEL = "google/gemini-4-neon";

export const GEMINI_MODEL_OPTIONS: readonly CloudAiModelOption[] = [
    { id: "gemini-4-neon", label: "Gemini 4 Neon" },
    { id: "gemini-4-hydrogen", label: "Gemini 4 Hydrogen" },
    { id: "gemini-4-carbon", label: "Gemini 4 Carbon" },
    { id: "gemini-4-argon", label: "Gemini 4 Argon" },
    { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
    { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite" },
    { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro Preview" },
];

export const OPENROUTER_MODEL_OPTIONS: readonly CloudAiModelOption[] = [
    { id: "google/gemini-4-neon", label: "Gemini 4 Neon (OpenRouter)" },
    { id: "google/gemini-4-hydrogen", label: "Gemini 4 Hydrogen (OpenRouter)" },
    { id: "google/gemini-4-carbon", label: "Gemini 4 Carbon (OpenRouter)" },
    { id: "google/gemini-4-argon", label: "Gemini 4 Argon (OpenRouter)" },
    { id: "google/gemini-3.8-flash", label: "Gemini 3.8 Flash (OpenRouter)" },
    { id: "google/gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite (OpenRouter)" },
    { id: "google/gemini-3.1-pro-preview", label: "Gemini 3.1 Pro Preview (OpenRouter)" },
    { id: "openai/gpt-audio", label: "GPT Audio (OpenRouter)" },
    { id: "qwen/qwen3.8-omni-flash", label: "Qwen 3.8 Omni Flash (OpenRouter)" },
];

export const DEFAULT_LINE_ALIGN_PROMPT =
    `你将收到一首歌曲的音频与对应的歌词原文。请仔细聆听人声演唱，为每一行歌词标注精确的发声开始时间，按标准 LRC 格式输出。

【歌词原文】（空行代表段落间隔或纯音乐间奏）
{lyrics}

请严格遵守以下规则：

1. **发声点精准对齐**：
   - 时间戳必须标在该句第一个字/音节**真正发声（人声起音）**的瞬间，不要提前标在伴奏、前奏鼓点或吸气声处，也不要滞后到强拍。
   - 多语言处理：英文注意连读起音；日语注意促音停顿与长音延续；中文注意拖腔与换气；副歌/重复段落按实际演唱顺序逐行对应，切勿跳行或错位。

2. **原文零改动与行数完全一致**：
   - 必须**原样保留**每行歌词的文字、大小写、空格和标点符号，严禁增删、改写、翻译、合并或拆分歌词行。
   - 输出总行数与顺序必须与原文 100% 一致（包含所有空行）。

3. **时间轴严格递增（最高优先级）**：
   - 每一行的时间戳必须**严格大于**上一行的时间戳，绝对禁止两行使用相同时间戳或时间倒退。
   - 空行保留为单独一行 \`[mm:ss.xxx]\`（后面不留任何文字），时间戳设为进入间奏/停顿的实际时刻，且至少比上一行晚 10ms、严格早于下一句。

4. **输出格式规范**：
   - 统一使用 \`[mm:ss.xxx]歌词内容\`（毫秒使用英文小数点 \`.\`，严禁使用逗号 \`,\`）。
   - **只输出纯 LRC 时间戳行**，不要输出 Markdown 代码块标记（如 \`\`\`）、标题、编号或任何解释文字。

5. **正误自查**：
   - ❌ 错误（空行与下一句时间戳重复）：
     [02:15.472]第一句
     [02:19.391]
     [02:19.391]下一句
   - ✅ 正确（严格递增）：
     [02:15.472]第一句
     [02:18.535]
     [02:19.391]下一句

现在请直接输出完整的标准 LRC 时间轴：`;

export const DEFAULT_TRANSCRIBE_ALIGN_PROMPT =
    `请仔细聆听这首歌曲的音频，完整听写歌手演唱的歌词内容，并为每一句标注精确的人声开始时间，按标准 LRC 格式输出。

请严格遵守以下规则：
1. 每行一句，格式为 \`[mm:ss.xxx]歌词内容\`（毫秒分隔符必须为英文小数点 \`.\`，严禁使用逗号 \`,\`）。
2. 开始时间必须标在该句第一个字/音节真正唱出的瞬间，不要标在前奏或伴奏进入点。
3. 保留完整演唱顺序，重复的副歌/段落全部写出不要省略；明显的纯音乐间奏或段落停顿可输出单独空行 \`[mm:ss.xxx]\`。
4. 时间轴必须严格递增，禁止重复或倒退；极难辨识的词句可用 \`[?]\` 标注。
5. 只输出纯 LRC 内容，不要输出 Markdown 代码块标记（\`\`\`）或任何解释性文字。`;

export const DEFAULT_WORD_ALIGN_BETA_PROMPT =
    `你将收到一首歌曲的音频与对应的歌词原文。请仔细聆听人声，为每一行中的每一个字或英文单词标注精确的开始与结束时间，按 Enhanced LRC 逐字格式输出。

【歌词原文】（空行代表段落间隔或间奏）
{lyrics}

请严格遵守以下规则：

1. **逐字格式规范（Enhanced LRC）**：
   - 每行格式：\`[mm:ss.xxx]<mm:ss.xxx>词1<mm:ss.xxx>词2<mm:ss.xxx>\`
   - 行首方括号 \`[mm:ss.xxx]\` 与该行第一个字词的 \`<mm:ss.xxx>\` 保持一致；行尾附加一个闭合的 \`<mm:ss.xxx>\` 表示该行最后一个音节收尾的时刻。
   - 中/日/韩文按单个字或假名音节切分；英文及其他拉丁语系按单词切分，并保留单词间的原始空格（如 \`<00:05.120>Hello <00:05.540>world<00:06.180>\`）。

2. **原文与结构严格一致**：
   - 原样保留所有文字、大小写、空格和标点，不增删改写；总行数与空行位置必须与原文完全一致。
   - 空行输出为单独一行 \`[mm:ss.xxx]\`（后面不加尖括号和文字）。

3. **时间严格单调递增**：
   - 行内每个 \`<mm:ss.xxx>\` 以及相邻行之间的时间戳都必须严格递增（至少不倒退、行间严格大于上一行），毫秒使用英文小数点 \`.\`。

4. **纯净输出**：
   - 只输出 Enhanced LRC 内容，不要输出 Markdown 代码块标记（\`\`\`）或任何解释文字。

现在请直接输出逐字 Enhanced LRC 时间轴：`;

export type CloudAiErrorCode =
    | "missing-key"
    | "invalid-key"
    | "rate-limited"
    | "quota-exceeded"
    | "media-too-large"
    | "upload-failed"
    | "network"
    | "cancelled"
    | "invalid-output"
    | "line-count-mismatch"
    | "truncated"
    | "failed";

export class CloudAiAlignmentError extends Error {
    constructor(
        readonly code: CloudAiErrorCode,
        message: string,
        readonly detail?: string,
    ) {
        super(message);
        this.name = CloudAiAlignmentError.name;
    }
}

export interface CloudAlignmentProgress extends LocalAlignmentProgress {
    streamChars?: number;
}

export interface CloudAlignmentOptions {
    provider: CloudAiProvider;
    model: string;
    apiKey?: string;
    audio: Blob;
    audioName: string;
    transcript: string;
    mode: CloudAiTaskMode;
    precision: 2 | 3;
    thinking: boolean;
    customLinePrompt?: string;
    customWordPrompt?: string;
    metadata?: ReadonlyMap<string, string>;
    trimOptions?: TrimOptios;
    signal?: AbortSignal;
    onProgress?: (progress: CloudAlignmentProgress) => void;
    fetchImpl?: typeof fetch;
    compressAudio?: (
        blob: Blob,
        name: string,
        bitrateKbps?: number,
    ) => Promise<{ blob: Blob; name: string; format: "m4a" }>;
}

export interface CloudAlignmentResult {
    mode: CloudAiTaskMode;
    lrc: string;
    lyrics: readonly ILyric[];
    advancedDocument?: AdvancedLyricsDocument;
    rawOutput: string;
}

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com";
const OPENROUTER_API_BASE = "https://openrouter.ai/api/v1";
const GEMINI_INLINE_MAX_BYTES = 8 * 1024 * 1024;
const GEMINI_UPLOAD_MAX_BYTES = 200 * 1024 * 1024;
const OPENROUTER_INLINE_MAX_BYTES = 6 * 1024 * 1024;
const OPENROUTER_HARD_MAX_BYTES = 18 * 1024 * 1024;
const MAX_STREAM_CHARS = 500_000;

export const isGemini4Model = (model: string): boolean =>
    model.trim().toLowerCase().replace(/^google\//, "").startsWith("gemini-4-");

export const buildAlignmentPrompt = (
    mode: CloudAiTaskMode,
    transcript: string,
    customLinePrompt?: string,
    customWordPrompt?: string,
): string => {
    if (mode === "transcribe") {
        return DEFAULT_TRANSCRIBE_ALIGN_PROMPT;
    }
    const baseTemplate = mode === "word-beta"
        ? (customWordPrompt?.trim() || DEFAULT_WORD_ALIGN_BETA_PROMPT)
        : (customLinePrompt?.trim() || DEFAULT_LINE_ALIGN_PROMPT);

    if (baseTemplate.includes("{lyrics}")) {
        return baseTemplate.replaceAll("{lyrics}", transcript);
    }
    return `${baseTemplate}\n\n【歌词原文】\n${transcript}`;
};

export const runCloudAiAlignment = async (options: CloudAlignmentOptions): Promise<CloudAlignmentResult> => {
    throwIfAborted(options.signal);
    const fetchFn = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    const apiKey = (options.apiKey ?? await loadEncryptedApiKey(options.provider))?.trim();
    if (!apiKey) {
        throw new CloudAiAlignmentError("missing-key", "API key is not configured");
    }

    const model = options.model.trim()
        || (options.provider === "gemini" ? DEFAULT_GEMINI_MODEL : DEFAULT_OPENROUTER_MODEL);
    const prompt = buildAlignmentPrompt(
        options.mode,
        options.transcript,
        options.customLinePrompt,
        options.customWordPrompt,
    );

    options.onProgress?.({ phase: "connecting", progress: 0.04 });

    const rawOutput = options.provider === "gemini"
        ? await invokeGeminiStream({
            apiKey,
            model,
            audio: options.audio,
            audioName: options.audioName,
            prompt,
            thinking: options.thinking,
            signal: options.signal,
            onProgress: options.onProgress,
            fetchFn,
        })
        : await invokeOpenRouterStream({
            apiKey,
            model,
            audio: options.audio,
            audioName: options.audioName,
            prompt,
            mode: options.mode,
            thinking: options.thinking,
            signal: options.signal,
            onProgress: options.onProgress,
            fetchFn,
            compressAudio: options.compressAudio,
        });

    throwIfAborted(options.signal);
    options.onProgress?.({ phase: "downloading", progress: 0.96, streamChars: rawOutput.length });

    if (options.mode === "word-beta") {
        const parsed = parseCloudWordAlignment(
            rawOutput,
            options.transcript,
            options.metadata,
            options.precision,
        );
        options.onProgress?.({ phase: "complete", progress: 1, streamChars: rawOutput.length });
        return {
            mode: "word-beta",
            lrc: parsed.lrc,
            lyrics: parsed.lyrics,
            advancedDocument: parsed.document,
            rawOutput,
        };
    }

    const parsed = parseCloudLineAlignment(
        rawOutput,
        options.mode === "line" ? options.transcript : "",
        options.precision,
        options.trimOptions,
    );
    options.onProgress?.({ phase: "complete", progress: 1, streamChars: rawOutput.length });
    return {
        mode: options.mode,
        lrc: parsed.lrc,
        lyrics: parsed.lyrics,
        rawOutput,
    };
};

export const testCloudAiConnection = async (
    provider: CloudAiProvider,
    apiKey: string,
    model: string,
    signal?: AbortSignal,
    fetchFn: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<void> => {
    const trimmedKey = apiKey.trim();
    if (!trimmedKey) {
        throw new CloudAiAlignmentError("missing-key", "API key is empty");
    }
    const targetModel = model.trim() || (provider === "gemini" ? DEFAULT_GEMINI_MODEL : DEFAULT_OPENROUTER_MODEL);
    if (provider === "gemini") {
        const url = `${GEMINI_API_BASE}/v1beta/models/${encodeURIComponent(targetModel)}`;
        let response: Response;
        try {
            response = await fetchFn(url, {
                method: "GET",
                headers: { "x-goog-api-key": trimmedKey },
                signal,
            });
        } catch (error) {
            throw normalizeFetchError(error, signal);
        }
        if (!response.ok) {
            const body = await safeReadText(response);
            throw mapHttpError(response.status, body);
        }
        return;
    }

    const url = `${OPENROUTER_API_BASE}/key`;
    let response: Response;
    try {
        response = await fetchFn(url, {
            method: "GET",
            headers: {
                Authorization: `Bearer ${trimmedKey}`,
                ...openRouterAppHeaders(),
            },
            signal,
        });
    } catch (error) {
        throw normalizeFetchError(error, signal);
    }
    if (!response.ok) {
        const body = await safeReadText(response);
        throw mapHttpError(response.status, body);
    }
};

interface GeminiStreamArgs {
    apiKey: string;
    model: string;
    audio: Blob;
    audioName: string;
    prompt: string;
    thinking: boolean;
    signal?: AbortSignal;
    onProgress?: (progress: CloudAlignmentProgress) => void;
    fetchFn: typeof fetch;
}

const invokeGeminiStream = async (args: GeminiStreamArgs): Promise<string> => {
    const { apiKey, model, audio, audioName, prompt, thinking, signal, onProgress, fetchFn } = args;
    if (audio.size <= 0 || audio.size > GEMINI_UPLOAD_MAX_BYTES) {
        throw new CloudAiAlignmentError("media-too-large", "Audio file size is not supported");
    }

    const mimeType = resolveAudioMimeType(audio.type, audioName);
    let uploadedFileName: string | null = null;

    try {
        let mediaPart: Record<string, unknown>;
        if (audio.size <= GEMINI_INLINE_MAX_BYTES) {
            onProgress?.({ phase: "uploading", progress: 0.14 });
            const base64 = encodeBase64(new Uint8Array(await audio.arrayBuffer()));
            throwIfAborted(signal);
            mediaPart = {
                inlineData: {
                    mimeType,
                    data: base64,
                },
            };
        } else {
            onProgress?.({ phase: "uploading", progress: 0.08 });
            const uploaded = await uploadGeminiFile(apiKey, audio, mimeType, signal, onProgress, fetchFn);
            uploadedFileName = uploaded.name;
            mediaPart = {
                fileData: {
                    fileUri: uploaded.uri,
                    mimeType,
                },
            };
        }

        onProgress?.({ phase: "running", progress: 0.25, streamChars: 0 });
        const thinkingLevel = thinking
            ? "high"
            : model.includes("flash-lite")
            ? "minimal"
            : "low";
        const generationConfig: Record<string, unknown> = {
            thinkingConfig: {
                thinkingLevel,
                includeThoughts: false,
            },
        };
        if (isGemini4Model(model)) {
            generationConfig.maxOutputTokens = 32_768;
        }

        const url = `${GEMINI_API_BASE}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
        let response: Response;
        try {
            response = await fetchFn(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-goog-api-key": apiKey,
                },
                body: JSON.stringify({
                    contents: [
                        {
                            role: "user",
                            parts: [mediaPart, { text: prompt }],
                        },
                    ],
                    generationConfig,
                }),
                signal,
            });
        } catch (error) {
            throw normalizeFetchError(error, signal);
        }

        if (!response.ok) {
            const body = await safeReadText(response);
            throw mapHttpError(response.status, body);
        }

        let output = "";
        await readSseJsonStream(response, signal, (chunk) => {
            const candidate = getFirstRecord(chunk.candidates);
            const finishReason = typeof candidate?.finishReason === "string" ? candidate.finishReason : "";
            if (finishReason === "MAX_TOKENS" || finishReason === "CONTINUATION") {
                throw new CloudAiAlignmentError("truncated", "Model output reached token limit");
            }
            const content = asRecord(candidate?.content);
            const parts = Array.isArray(content?.parts) ? content.parts : [];
            for (const part of parts) {
                const record = asRecord(part);
                if (!record || record.thought === true) continue;
                if (typeof record.text === "string" && record.text.length > 0) {
                    output += record.text;
                    if (output.length > MAX_STREAM_CHARS) {
                        throw new CloudAiAlignmentError("truncated", "Model output exceeded maximum size");
                    }
                    const estimatedProgress = Math.min(0.93, 0.28 + Math.log1p(output.length / 400) * 0.22);
                    onProgress?.({
                        phase: "running",
                        progress: estimatedProgress,
                        streamChars: output.length,
                    });
                }
            }
        });

        if (!output.trim()) {
            throw new CloudAiAlignmentError("invalid-output", "Model returned an empty response");
        }
        return output;
    } finally {
        if (uploadedFileName) {
            await fetchFn(`${GEMINI_API_BASE}/v1beta/${uploadedFileName}`, {
                method: "DELETE",
                headers: { "x-goog-api-key": apiKey },
            }).catch(() => undefined);
        }
    }
};

const uploadGeminiFile = async (
    apiKey: string,
    audio: Blob,
    mimeType: string,
    signal: AbortSignal | undefined,
    onProgress: ((progress: CloudAlignmentProgress) => void) | undefined,
    fetchFn: typeof fetch,
): Promise<{ name: string; uri: string }> => {
    let fileInfo: Record<string, unknown> | null = null;
    try {
        const startResponse = await fetchFn(`${GEMINI_API_BASE}/upload/v1beta/files`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-goog-api-key": apiKey,
                "x-goog-upload-protocol": "resumable",
                "x-goog-upload-command": "start",
                "x-goog-upload-header-content-length": String(audio.size),
                "x-goog-upload-header-content-type": mimeType,
            },
            body: JSON.stringify({ file: { display_name: "lrc-editor-audio" } }),
            signal,
        });
        if (!startResponse.ok) {
            const body = await safeReadText(startResponse);
            throw mapHttpError(startResponse.status, body);
        }
        const uploadUrl = startResponse.headers.get("x-goog-upload-url");
        if (uploadUrl && isTrustedGoogleUploadUrl(uploadUrl)) {
            onProgress?.({ phase: "uploading", progress: 0.14 });
            const uploadResponse = await fetchFn(uploadUrl, {
                method: "POST",
                headers: {
                    "x-goog-upload-offset": "0",
                    "x-goog-upload-command": "upload, finalize",
                    "Content-Type": mimeType,
                },
                body: audio,
                signal,
            });
            if (!uploadResponse.ok) {
                const body = await safeReadText(uploadResponse);
                throw mapHttpError(uploadResponse.status, body);
            }
            const json = (await uploadResponse.json()) as Record<string, unknown>;
            fileInfo = asRecord(json.file);
        } else {
            fileInfo = await uploadGeminiMultipart(apiKey, audio, mimeType, signal, fetchFn);
        }
    } catch (error) {
        if (error instanceof CloudAiAlignmentError) throw error;
        throw normalizeFetchError(error, signal, "upload-failed");
    }

    const name = typeof fileInfo?.name === "string" ? fileInfo.name : "";
    if (!name.startsWith("files/") || name.includes("..")) {
        throw new CloudAiAlignmentError("upload-failed", "Invalid uploaded file identifier");
    }

    onProgress?.({ phase: "uploading", progress: 0.2 });
    let current = fileInfo;
    for (let attempt = 0; attempt < 60; attempt += 1) {
        const state = typeof current?.state === "string" ? current.state : "";
        const uri = typeof current?.uri === "string" ? current.uri : "";
        if ((state === "ACTIVE" || state === "") && uri) {
            return { name, uri };
        }
        if (state === "FAILED") {
            throw new CloudAiAlignmentError("upload-failed", "Audio file processing failed on Gemini");
        }
        await abortableDelay(1_500, signal);
        let pollResponse: Response;
        try {
            pollResponse = await fetchFn(`${GEMINI_API_BASE}/v1beta/${name}`, {
                method: "GET",
                headers: { "x-goog-api-key": apiKey },
                signal,
            });
        } catch (error) {
            throw normalizeFetchError(error, signal, "upload-failed");
        }
        if (!pollResponse.ok) {
            const body = await safeReadText(pollResponse);
            throw mapHttpError(pollResponse.status, body);
        }
        current = asRecord(await pollResponse.json());
    }
    throw new CloudAiAlignmentError("upload-failed", "Timed out waiting for uploaded audio processing");
};

const uploadGeminiMultipart = async (
    apiKey: string,
    audio: Blob,
    mimeType: string,
    signal: AbortSignal | undefined,
    fetchFn: typeof fetch,
): Promise<Record<string, unknown> | null> => {
    const boundary = `lrc-editor-${Math.random().toString(16).slice(2)}`;
    const metadataPart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${
        JSON.stringify({ file: { display_name: "lrc-editor-audio" } })
    }\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`;
    const closingPart = `\r\n--${boundary}--\r\n`;
    const body = new Blob([metadataPart, audio, closingPart]);
    const response = await fetchFn(`${GEMINI_API_BASE}/upload/v1beta/files?uploadType=multipart`, {
        method: "POST",
        headers: {
            "Content-Type": `multipart/related; boundary=${boundary}`,
            "x-goog-api-key": apiKey,
        },
        body,
        signal,
    });
    if (!response.ok) {
        const text = await safeReadText(response);
        throw mapHttpError(response.status, text);
    }
    const json = (await response.json()) as Record<string, unknown>;
    return asRecord(json.file);
};

interface OpenRouterStreamArgs {
    apiKey: string;
    model: string;
    audio: Blob;
    audioName: string;
    prompt: string;
    mode: CloudAiTaskMode;
    thinking: boolean;
    signal?: AbortSignal;
    onProgress?: (progress: CloudAlignmentProgress) => void;
    fetchFn: typeof fetch;
    compressAudio?: (
        blob: Blob,
        name: string,
        bitrateKbps?: number,
    ) => Promise<{ blob: Blob; name: string; format: "m4a" }>;
}

const invokeOpenRouterStream = async (args: OpenRouterStreamArgs): Promise<string> => {
    const { apiKey, model, prompt, mode, thinking, signal, onProgress, fetchFn } = args;
    let workingBlob = args.audio;
    let workingName = args.audioName;
    let format = resolveOpenRouterAudioFormat(workingBlob.type, workingName);

    const needsCompression = workingBlob.size > OPENROUTER_INLINE_MAX_BYTES
        || !format
        || workingBlob.type.startsWith("video/");

    if (needsCompression) {
        onProgress?.({ phase: "uploading", progress: 0.08 });
        try {
            const compressor = args.compressAudio
                ?? (await import("./audio-transcoder.js")).transcodeAudioForCloudAi;
            const compressed = await compressor(workingBlob, workingName, 64);
            throwIfAborted(signal);
            workingBlob = compressed.blob;
            workingName = compressed.name;
            format = compressed.format;
        } catch (error) {
            if (error instanceof CloudAiAlignmentError) throw error;
            if (!format || workingBlob.size > OPENROUTER_HARD_MAX_BYTES) {
                throw new CloudAiAlignmentError("media-too-large", "Audio could not be prepared for OpenRouter");
            }
        }
    }

    if (workingBlob.size <= 0 || workingBlob.size > OPENROUTER_HARD_MAX_BYTES) {
        throw new CloudAiAlignmentError("media-too-large", "Audio file exceeds OpenRouter inline payload limit");
    }

    onProgress?.({ phase: "uploading", progress: 0.16 });
    const base64 = encodeBase64(new Uint8Array(await workingBlob.arrayBuffer()));
    throwIfAborted(signal);

    onProgress?.({ phase: "running", progress: 0.25, streamChars: 0 });
    const body: Record<string, unknown> = {
        model,
        stream: true,
        max_tokens: mode === "word-beta" ? 12_288 : 8_192,
        messages: [
            {
                role: "user",
                content: [
                    {
                        type: "input_audio",
                        input_audio: {
                            data: base64,
                            format: format || "mp3",
                        },
                    },
                    {
                        type: "text",
                        text: prompt,
                    },
                ],
            },
        ],
    };

    if (model.toLowerCase().includes("gemini")) {
        body.reasoning = { effort: thinking ? "high" : "low" };
    } else if (thinking) {
        body.reasoning = { enabled: true };
    }

    let response: Response;
    try {
        response = await fetchFn(`${OPENROUTER_API_BASE}/chat/completions`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
                ...openRouterAppHeaders(),
            },
            body: JSON.stringify(body),
            signal,
        });
    } catch (error) {
        throw normalizeFetchError(error, signal);
    }

    if (!response.ok) {
        const text = await safeReadText(response);
        throw mapHttpError(response.status, text);
    }

    let output = "";
    await readSseJsonStream(response, signal, (chunk) => {
        if (chunk.error) {
            const errRecord = asRecord(chunk.error);
            const msg = typeof errRecord?.message === "string" ? errRecord.message : "OpenRouter stream error";
            throw new CloudAiAlignmentError("failed", msg);
        }
        const choice = getFirstRecord(chunk.choices);
        const finishReason = typeof choice?.finish_reason === "string" ? choice.finish_reason : "";
        if (finishReason === "length") {
            throw new CloudAiAlignmentError("truncated", "Model output reached token limit");
        }
        const delta = asRecord(choice?.delta);
        const content = delta?.content;
        if (typeof content === "string" && content.length > 0) {
            output += content;
            if (output.length > MAX_STREAM_CHARS) {
                throw new CloudAiAlignmentError("truncated", "Model output exceeded maximum size");
            }
            const estimatedProgress = Math.min(0.93, 0.28 + Math.log1p(output.length / 400) * 0.22);
            onProgress?.({
                phase: "running",
                progress: estimatedProgress,
                streamChars: output.length,
            });
        }
    });

    if (!output.trim()) {
        throw new CloudAiAlignmentError("invalid-output", "Model returned an empty response");
    }
    return output;
};

interface ParsedCue {
    startMs: number;
    endMs?: number;
    text: string;
}

const cueTimestampLinePattern =
    /^\s*(?:[-*]\s+)?[[<]?(?<start>\d{1,3}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)(?:\s*(?:-->|→|–|—|-)\s*(?<end>\d{1,3}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?))?[\]>]?\s*(?:[:：]\s*)?/;

export const stripModelCodeFences = (raw: string): string => {
    const trimmed = raw.replace(/\r\n?/g, "\n").trim();
    const fenceMatch = /^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/m.exec(trimmed);
    if (fenceMatch) return fenceMatch[1].trim();
    return trimmed
        .replace(/^```[a-zA-Z0-9_-]*\s*\n?/gm, "")
        .replace(/\n?```\s*$/gm, "")
        .trim();
};

export const parseModelTimestampCues = (rawOutput: string): ParsedCue[] => {
    const cleaned = stripModelCodeFences(rawOutput);
    const lines = cleaned.split("\n");
    const cues: ParsedCue[] = [];
    let skipUntil = 0;

    for (let index = 0; index < lines.length; index += 1) {
        if (index < skipUntil) continue;
        const line = lines[index];
        const match = cueTimestampLinePattern.exec(line);
        if (!match?.groups?.start) continue;

        const startMs = parseStrictTimeMs(match.groups.start);
        if (startMs === undefined) continue;
        const endMs = match.groups.end ? parseStrictTimeMs(match.groups.end) : undefined;
        let content = line
            .slice(match[0].length)
            .replace(/^[\]>:\-–—\s]+/, (prefix) => (prefix.includes("]") || prefix.includes(">") ? "" : prefix))
            .trim();

        // Support multi-line SRT blocks where text follows the `start --> end` line.
        if (!content && line.includes("-->") && !line.trimStart().startsWith("[")) {
            const captionParts: string[] = [];
            for (let nextIndex = index + 1; nextIndex < lines.length; nextIndex += 1) {
                const nextLine = lines[nextIndex];
                if (!nextLine.trim()) break;
                if (cueTimestampLinePattern.test(nextLine)) break;
                if (
                    /^\d+$/.test(nextLine.trim()) && lines[nextIndex + 1]
                    && cueTimestampLinePattern.test(lines[nextIndex + 1])
                ) {
                    break;
                }
                captionParts.push(nextLine.trim());
                skipUntil = nextIndex + 1;
            }
            content = captionParts.join(" ").trim();
        }

        cues.push({ startMs, endMs, text: content });
    }
    return cues;
};

export const parseCloudLineAlignment = (
    rawOutput: string,
    originalTranscript: string,
    precision: 2 | 3,
    trimOptions: TrimOptios = {},
): { lrc: string; lyrics: readonly ILyric[] } => {
    const cues = parseModelTimestampCues(rawOutput);
    if (cues.length === 0) {
        throw new CloudAiAlignmentError("invalid-output", "No valid timestamps found in AI output");
    }

    const outputLines: string[] = [];
    const normalizedOriginal = originalTranscript.replace(/\r\n?/g, "\n").trim();

    if (!normalizedOriginal) {
        let prevMs = -1;
        for (const cue of cues) {
            const startMs = Math.max(cue.startMs, prevMs + (prevMs >= 0 ? 10 : 0));
            outputLines.push(`${formatLrcTimestamp(startMs, precision)}${cue.text}`);
            prevMs = startMs;
        }
    } else {
        const originalLines = normalizedOriginal.split("\n");
        const nonEmptyOriginalCount = originalLines.filter((line) => line.trim().length > 0).length;
        const nonEmptyCues = cues.filter((cue) => cue.text.trim().length > 0);

        if (nonEmptyCues.length !== nonEmptyOriginalCount) {
            throw new CloudAiAlignmentError(
                "line-count-mismatch",
                `Expected ${nonEmptyOriginalCount} timed lyric lines, got ${nonEmptyCues.length}`,
                `${nonEmptyCues.length}/${nonEmptyOriginalCount}`,
            );
        }

        // Preserve AI blank-line timestamps when exact line count matches, otherwise derive monotonic blank-line stamps cleanly.
        const exactCountMatch = cues.length === originalLines.length
            && cues.every((cue, idx) => Boolean(cue.text.trim()) === Boolean(originalLines[idx].trim()));

        const resolvedTimes: number[] = [];
        let nonEmptyCursor = 0;
        for (let idx = 0; idx < originalLines.length; idx += 1) {
            const origText = originalLines[idx].trim();
            if (exactCountMatch) {
                resolvedTimes.push(cues[idx].startMs);
            } else if (origText) {
                resolvedTimes.push(nonEmptyCues[nonEmptyCursor].startMs);
                nonEmptyCursor += 1;
            } else {
                const prevTime = resolvedTimes.at(-1) ?? 0;
                const prevCue = nonEmptyCursor > 0 ? nonEmptyCues[nonEmptyCursor - 1] : undefined;
                const nextCue = nonEmptyCues[nonEmptyCursor];
                const candidate = prevCue?.endMs && prevCue.endMs > prevTime
                    ? prevCue.endMs
                    : nextCue && nextCue.startMs > prevTime + 400
                    ? Math.round((prevTime + nextCue.startMs) / 2)
                    : prevTime + 10;
                resolvedTimes.push(candidate);
            }
        }

        // Enforce strictly increasing timestamps respecting precision granularity.
        const minStepMs = precision === 2 ? 10 : 1;
        let previousMs = -minStepMs;
        for (let idx = 0; idx < originalLines.length; idx += 1) {
            const nextOriginalNonEmptyMs = findNextNonEmptyTime(originalLines, resolvedTimes, idx + 1);
            let timeMs = resolvedTimes[idx];
            if (timeMs <= previousMs) {
                timeMs = previousMs + Math.max(minStepMs, 10);
                if (nextOriginalNonEmptyMs !== undefined && timeMs >= nextOriginalNonEmptyMs) {
                    timeMs = previousMs + minStepMs;
                }
            }
            outputLines.push(`${formatLrcTimestamp(timeMs, precision)}${originalLines[idx].trim()}`);
            previousMs = timeMs;
        }
    }

    const lrc = outputLines.join("\n");
    const parsed = parser(lrc, trimOptions);
    if (parsed.lyric.length === 0) {
        throw new CloudAiAlignmentError("invalid-output", "Parsed LRC contained no lines");
    }
    return { lrc, lyrics: parsed.lyric };
};

export const parseCloudWordAlignment = (
    rawOutput: string,
    originalTranscript: string,
    metadata: ReadonlyMap<string, string> | undefined,
    precision: 2 | 3,
): { document: AdvancedLyricsDocument; lrc: string; lyrics: readonly ILyric[] } => {
    const cleaned = stripModelCodeFences(rawOutput);
    const candidateLines = cleaned
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => /^\[\s*\d{1,3}:\d{2}(?:[.:]\d{1,3})?\s*\]/.test(line));

    if (candidateLines.length === 0) {
        throw new CloudAiAlignmentError("invalid-output", "No Enhanced LRC word lines found in AI output");
    }

    const parsedDoc = parseEnhancedLrc(candidateLines.join("\n"));
    if (!hasWordTiming(parsedDoc)) {
        throw new CloudAiAlignmentError("invalid-output", "AI output did not include word-level timestamps");
    }

    const normalizedOriginal = originalTranscript.replace(/\r\n?/g, "\n").trim();
    const origLines = normalizedOriginal ? normalizedOriginal.split("\n") : [];
    const nonEmptyOrigCount = origLines.filter((line) => line.trim().length > 0).length;
    const nonEmptyParsedLines = parsedDoc.lines.filter((line) => lineText(line).trim().length > 0);

    if (nonEmptyOrigCount > 0 && nonEmptyParsedLines.length !== nonEmptyOrigCount) {
        throw new CloudAiAlignmentError(
            "line-count-mismatch",
            `Expected ${nonEmptyOrigCount} word-timed lines, got ${nonEmptyParsedLines.length}`,
            `${nonEmptyParsedLines.length}/${nonEmptyOrigCount}`,
        );
    }

    const minStepMs = precision === 2 ? 10 : 1;
    const normalizedLines: AdvancedLyricLine[] = [];
    const exactMatch = origLines.length > 0
        && parsedDoc.lines.length === origLines.length
        && parsedDoc.lines.every((line, idx) => Boolean(lineText(line).trim()) === Boolean(origLines[idx].trim()));

    let prevLineStartMs = -minStepMs;
    let nonEmptyCursor = 0;

    const sourceList = origLines.length > 0 ? origLines : parsedDoc.lines.map((line) => lineText(line));
    for (let idx = 0; idx < sourceList.length; idx += 1) {
        const isBlank = origLines.length > 0 ? !origLines[idx].trim() : !lineText(parsedDoc.lines[idx]).trim();
        if (isBlank) {
            const rawBlankMs = exactMatch
                ? parsedDoc.lines[idx].startMs
                : (normalizedLines.at(-1)?.endMs ?? prevLineStartMs + 200);
            const startMs = Math.max(rawBlankMs ?? prevLineStartMs + minStepMs, prevLineStartMs + minStepMs);
            normalizedLines.push({ startMs, words: [{ text: "" }] });
            prevLineStartMs = startMs;
            continue;
        }

        const parsedLine = exactMatch
            ? parsedDoc.lines[idx]
            : origLines.length > 0
            ? nonEmptyParsedLines[nonEmptyCursor++]
            : parsedDoc.lines[idx];

        const baseStart = parsedLine.startMs ?? parsedLine.words.find((w) => w.startMs !== undefined)?.startMs ?? 0;
        const lineStartMs = Math.max(baseStart, prevLineStartMs + minStepMs);
        let wordCursorMs = lineStartMs;
        const normalizedWords: TimedWord[] = parsedLine.words.map((word) => {
            const startMs = Math.max(word.startMs ?? wordCursorMs, wordCursorMs);
            const endMs = word.endMs !== undefined ? Math.max(word.endMs, startMs) : undefined;
            wordCursorMs = endMs ?? startMs;
            return endMs === undefined
                ? { text: word.text, startMs }
                : { text: word.text, startMs, endMs };
        });

        const lineEndMs = parsedLine.endMs !== undefined
            ? Math.max(parsedLine.endMs, wordCursorMs)
            : wordCursorMs > lineStartMs
            ? wordCursorMs
            : undefined;

        normalizedLines.push({
            startMs: lineStartMs,
            ...(lineEndMs === undefined ? {} : { endMs: lineEndMs }),
            words: normalizedWords,
        });
        prevLineStartMs = lineStartMs;
    }

    const docMetadata = metadata ? Object.fromEntries(metadata.entries()) : {};
    const document: AdvancedLyricsDocument = {
        sourceFormat: "enhanced-lrc",
        timingMode: "word",
        metadata: docMetadata,
        lines: normalizedLines,
    };

    const lyrics = documentToBasicLyrics(document);
    const lrc = normalizedLines
        .map((line) => `${formatLrcTimestamp(line.startMs ?? 0, precision)}${lineText(line)}`)
        .join("\n");

    return { document, lrc, lyrics };
};

const findNextNonEmptyTime = (
    originalLines: readonly string[],
    times: readonly number[],
    fromIndex: number,
): number | undefined => {
    for (let idx = fromIndex; idx < originalLines.length; idx += 1) {
        if (originalLines[idx].trim()) return times[idx];
    }
    return undefined;
};

const parseStrictTimeMs = (raw: string): number | undefined => {
    const parts = raw.trim().split(":");
    if (parts.length < 2 || parts.length > 3) return undefined;
    const secPart = parts.at(-1)!.replace(",", ".");
    const secVal = Number(secPart);
    if (!Number.isFinite(secVal) || secVal < 0 || secVal >= 60) return undefined;
    if (parts.length === 3) {
        const minVal = Number(parts[1]);
        if (!Number.isInteger(minVal) || minVal < 0 || minVal >= 60) return undefined;
    }
    return parseFlexibleTimestamp(raw);
};

const readSseJsonStream = async (
    response: Response,
    signal: AbortSignal | undefined,
    onChunk: (chunk: Record<string, unknown>) => void,
): Promise<void> => {
    if (!response.body) {
        const text = await response.text();
        parseSseLines(text.split(/\r?\n/), onChunk);
        return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
        while (true) {
            throwIfAborted(signal);
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() ?? "";
            parseSseLines(lines, onChunk);
        }
        buffer += decoder.decode();
        if (buffer.trim()) {
            parseSseLines(buffer.split(/\r?\n/), onChunk);
        }
    } catch (error) {
        if (error instanceof CloudAiAlignmentError) throw error;
        throw normalizeFetchError(error, signal);
    } finally {
        reader.releaseLock();
    }
};

const parseSseLines = (lines: readonly string[], onChunk: (chunk: Record<string, unknown>) => void): void => {
    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith(":")) continue;
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let parsed: unknown;
        try {
            parsed = JSON.parse(payload);
        } catch {
            continue;
        }
        const record = asRecord(parsed);
        if (record) onChunk(record);
    }
};

const resolveAudioMimeType = (rawType: string, name: string): string => {
    const clean = rawType.split(";", 1)[0].trim().toLowerCase();
    if (clean && clean !== "application/octet-stream") {
        if (clean === "audio/x-m4a") return "audio/mp4";
        if (clean === "audio/x-flac") return "audio/flac";
        if (clean === "audio/x-wav") return "audio/wav";
        return clean;
    }
    const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1].toLowerCase();
    switch (ext) {
        case "mp3":
            return "audio/mpeg";
        case "wav":
            return "audio/wav";
        case "m4a":
            return "audio/mp4";
        case "mp4":
            return "video/mp4";
        case "aac":
            return "audio/aac";
        case "flac":
            return "audio/flac";
        case "ogg":
        case "oga":
            return "audio/ogg";
        case "opus":
            return "audio/opus";
        case "webm":
            return "audio/webm";
        default:
            return "audio/mpeg";
    }
};

const resolveOpenRouterAudioFormat = (rawType: string, name: string): string | null => {
    const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1].toLowerCase();
    if (ext && ["mp3", "wav", "m4a", "aac", "ogg", "flac", "opus", "webm"].includes(ext)) {
        return ext;
    }
    const clean = rawType.split(";", 1)[0].trim().toLowerCase();
    if (clean === "audio/mpeg" || clean === "audio/mp3") return "mp3";
    if (clean === "audio/wav" || clean === "audio/x-wav") return "wav";
    if (clean === "audio/mp4" || clean === "audio/x-m4a") return "m4a";
    if (clean === "audio/aac") return "aac";
    if (clean === "audio/ogg") return "ogg";
    if (clean === "audio/flac" || clean === "audio/x-flac") return "flac";
    if (clean === "audio/opus") return "opus";
    if (clean === "audio/webm") return "webm";
    return null;
};

const openRouterAppHeaders = (): Record<string, string> => {
    const headers: Record<string, string> = { "X-Title": "LRC Editor" };
    if (typeof location !== "undefined" && /^https?:\/\//i.test(location.origin)) {
        headers["HTTP-Referer"] = location.origin;
    }
    return headers;
};

const isTrustedGoogleUploadUrl = (value: string): boolean => {
    try {
        const parsed = new URL(value);
        return parsed.protocol === "https:" && parsed.hostname.endsWith(".googleapis.com");
    } catch {
        return false;
    }
};

const mapHttpError = (status: number, body: string): CloudAiAlignmentError => {
    const lower = body.toLowerCase();
    if (status === 401 || status === 403 || lower.includes("api_key_invalid") || lower.includes("invalid api key")) {
        return new CloudAiAlignmentError("invalid-key", `Authentication failed (HTTP ${status})`, `HTTP ${status}`);
    }
    if (status === 402 || lower.includes("insufficient") || lower.includes("billing") || lower.includes("credit")) {
        return new CloudAiAlignmentError("quota-exceeded", `Quota or billing error (HTTP ${status})`, `HTTP ${status}`);
    }
    if (status === 429) {
        return new CloudAiAlignmentError("rate-limited", "Rate limit exceeded (HTTP 429)", "HTTP 429");
    }
    if (status === 413) {
        return new CloudAiAlignmentError("media-too-large", "Audio payload too large (HTTP 413)", "HTTP 413");
    }
    return new CloudAiAlignmentError("failed", `Provider request failed (HTTP ${status})`, `HTTP ${status}`);
};

const normalizeFetchError = (
    error: unknown,
    signal: AbortSignal | undefined,
    fallbackCode: CloudAiErrorCode = "network",
): CloudAiAlignmentError => {
    if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
        return new CloudAiAlignmentError("cancelled", "AI alignment stopped by the user");
    }
    if (error instanceof CloudAiAlignmentError) return error;
    return new CloudAiAlignmentError(
        fallbackCode,
        error instanceof Error ? error.message : "Network request failed",
    );
};

const safeReadText = async (response: Response): Promise<string> => {
    try {
        return (await response.text()).slice(0, 2000);
    } catch {
        return "";
    }
};

const throwIfAborted = (signal?: AbortSignal): void => {
    if (signal?.aborted) {
        throw new CloudAiAlignmentError("cancelled", "AI alignment stopped by the user");
    }
};

const abortableDelay = (timeoutMs: number, signal?: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new CloudAiAlignmentError("cancelled", "AI alignment stopped by the user"));
            return;
        }
        const timer = globalThis.setTimeout(finish, timeoutMs);
        const onAbort = (): void => {
            globalThis.clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            reject(new CloudAiAlignmentError("cancelled", "AI alignment stopped by the user"));
        };
        function finish(): void {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }
        signal?.addEventListener("abort", onAbort, { once: true });
    });

const asRecord = (value: unknown): Record<string, unknown> | null =>
    typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;

const getFirstRecord = (value: unknown): Record<string, unknown> | null =>
    Array.isArray(value) && value.length > 0 ? asRecord(value[0]) : null;

const encodeBase64 = (bytes: Uint8Array): string => {
    let binary = "";
    for (let index = 0; index < bytes.length; index += 32_768) {
        binary += String.fromCharCode(...bytes.subarray(index, index + 32_768));
    }
    return btoa(binary);
};
