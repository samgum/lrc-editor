import { useReducer } from "react";
import { defaultKeyBindings } from "../utils/default-keybindings.js";
import { normalizeKeyBindings } from "../utils/keybindings.js";

export const themeColor = {
    orange: "#ff691f",
    yellow: "#fab81e",
    lime: "#7fdbb6",
    green: "#19cf86",
    blue: "#91d2fa",
    navy: "#1b95e0",
    grey: "#abb8c2",
    red: "#e81c4f",
    pink: "#f58ea8",
    purple: "#c877fe",
};

export const enum ThemeMode {
    auto,
    light,
    dark,
}

export type WordCaptureMode = "tap" | "hold" | "waveform";
export type TimingWaveformView = "waveform" | "spectrogram";
export type LineCaptureMode = "standard" | "waveform";

const initState = {
    lang: "en-US",
    spaceStart: 0,
    spaceEnd: 0,
    fixed: 3 as Fixed,
    builtInAudio: false,
    showWaveform: true,
    screenButton: false,
    themeColor: themeColor.pink,
    themeMode: ThemeMode.auto,
    seekStepMs: 5000,
    fineTuneMs: 100,
    interactiveSeek: false,
    allowBackgroundAudio: false,
    aiAlignmentEnabled: false,
    aiGpuAcceleration: true,
    keepAiTaskCache: false,
    advancedLyricsEnabled: false,
    lineCaptureMode: "standard" as LineCaptureMode,
    lineWaveformAutoAdvance: false,
    lineWaveformPlayAfterSet: false,
    wordCaptureMode: "tap" as WordCaptureMode,
    timingWaveformView: "waveform" as TimingWaveformView,
    timingWaveformZoom: 84,
    timingWaveformAmplitude: 1,
    timingSpectrumBrightness: 1,
    timingWaveformHeight: 42,
    wordTimingCompensationMs: 0,
    wordPreviewLeadMs: 750,
    keyBindings: defaultKeyBindings,
};

export type State = Readonly<typeof initState>;

export type Action = {
    [key in keyof State]: { type: key; payload: State[key] | ((state: State) => State[key]) };
}[keyof State];

const reducer = (state: State, action: Action): State => {
    const payload = action.payload;
    return {
        ...state,
        [action.type]: typeof payload === "function" ? payload(state) : payload,
    };
};

const resolveBrowserLocale = (raw: string, supported: readonly string[]): string => {
    if (supported.includes(raw)) return raw;
    const normalized = raw.trim().replace(/_/g, "-").toLowerCase();
    const exact = supported.find((code) => code.toLowerCase() === normalized);
    if (exact) return exact;
    if (normalized.startsWith("zh")) {
        if (normalized.includes("-hk") || normalized.includes("-mo")) return "zh-HK";
        if (normalized.includes("-tw") || normalized.includes("-hant")) return "zh-TW";
        return "zh-CN";
    }
    if (normalized.startsWith("en")) return "en-US";
    if (normalized.startsWith("ja")) return "ja";
    if (normalized.startsWith("ko")) return "ko-KR";
    if (normalized.startsWith("pl")) return "pl-PL";
    if (normalized.startsWith("pt")) return "pt-BR";
    if (normalized.startsWith("sk")) return "sk-SK";
    return raw;
};

const clampInt = (value: unknown, min: number, max: number, fallback: number): number => {
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, Math.round(parsed)));
};

const init = (lazyInit: () => string): State => {
    const langCodeList = i18n.langCodeList;
    const state: Mutable<State> = { ...initState };

    const languages = navigator.languages || [navigator.language || "en-US"];

    state.lang = languages
        .map((langCode) => resolveBrowserLocale(langCode, langCodeList))
        .find((langCode) => langCodeList.includes(langCode)) || "en-US";

    try {
        const storedState = JSON.parse(lazyInit()) as Partial<State> & {
            wordHoldMode?: boolean;
            wordWaveformView?: TimingWaveformView;
            wordWaveformZoom?: number;
            wordWaveformAmplitude?: number;
        };
        if (storedState && typeof storedState === "object") {
            const validKeys = Object.keys(initState) as (keyof State)[];
            for (const key of validKeys) {
                if (key in storedState) {
                    (state[key] as unknown) = storedState[key];
                }
            }
            if (!("wordCaptureMode" in storedState) && storedState.wordHoldMode) {
                state.wordCaptureMode = "hold";
            }
            if (!("timingWaveformView" in storedState) && storedState.wordWaveformView) {
                state.timingWaveformView = storedState.wordWaveformView;
            }
            if (!("timingWaveformZoom" in storedState) && storedState.wordWaveformZoom) {
                state.timingWaveformZoom = storedState.wordWaveformZoom;
            }
            if (!("timingWaveformAmplitude" in storedState) && storedState.wordWaveformAmplitude) {
                state.timingWaveformAmplitude = storedState.wordWaveformAmplitude;
            }
        }
    } catch {
        // It's OK if parsing failed
    }
    if (typeof state.lang !== "string" || !langCodeList.includes(state.lang)) {
        state.lang = langCodeList.includes("en-US") ? "en-US" : (langCodeList[0] || "en-US");
    }
    if (!([0, 1, 2, 3] as const).includes(state.fixed)) {
        state.fixed = 3;
    }
    state.spaceStart = clampInt(state.spaceStart, -1, 16, 0);
    state.spaceEnd = clampInt(state.spaceEnd, -1, 16, 0);
    state.builtInAudio = Boolean(state.builtInAudio);
    state.showWaveform = Boolean(state.showWaveform);
    state.screenButton = Boolean(state.screenButton);
    state.interactiveSeek = Boolean(state.interactiveSeek);
    state.allowBackgroundAudio = Boolean(state.allowBackgroundAudio);
    state.aiAlignmentEnabled = Boolean(state.aiAlignmentEnabled);
    state.aiGpuAcceleration = Boolean(state.aiGpuAcceleration);
    state.keepAiTaskCache = Boolean(state.keepAiTaskCache);
    state.advancedLyricsEnabled = Boolean(state.advancedLyricsEnabled);
    state.lineWaveformAutoAdvance = Boolean(state.lineWaveformAutoAdvance);
    state.lineWaveformPlayAfterSet = Boolean(state.lineWaveformPlayAfterSet);
    if (typeof state.themeColor !== "string" || !/^#[\da-f]{6}$/i.test(state.themeColor)) {
        state.themeColor = themeColor.pink;
    }
    if (!([ThemeMode.auto, ThemeMode.light, ThemeMode.dark] as const).includes(state.themeMode)) {
        state.themeMode = ThemeMode.auto;
    }
    state.seekStepMs = clampInt(state.seekStepMs, 500, 60_000, 5000);
    state.fineTuneMs = clampInt(state.fineTuneMs, 10, 5000, 100);
    state.wordTimingCompensationMs = clampInt(state.wordTimingCompensationMs, -2000, 2000, 0);
    state.wordPreviewLeadMs = clampInt(state.wordPreviewLeadMs, 0, 5000, 750);
    state.keyBindings = normalizeKeyBindings(state.keyBindings);
    if (!(["tap", "hold", "waveform"] as const).includes(state.wordCaptureMode)) {
        state.wordCaptureMode = "tap";
    }
    if (!(["standard", "waveform"] as const).includes(state.lineCaptureMode)) {
        state.lineCaptureMode = "standard";
    }
    if (!(["waveform", "spectrogram"] as const).includes(state.timingWaveformView)) {
        state.timingWaveformView = "waveform";
    }
    state.timingWaveformZoom = Math.max(24, Math.min(420, Number(state.timingWaveformZoom) || 84));
    state.timingWaveformAmplitude = Math.max(0.25, Math.min(4, Number(state.timingWaveformAmplitude) || 1));
    state.timingSpectrumBrightness = Math.max(0.5, Math.min(4, Number(state.timingSpectrumBrightness) || 1));
    state.timingWaveformHeight = Math.max(24, Math.min(70, Number(state.timingWaveformHeight) || 42));
    return state;
};

export const usePref = (lazyInit: () => string): [State, React.Dispatch<Action>] => useReducer(reducer, lazyInit, init);
