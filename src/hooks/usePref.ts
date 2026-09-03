import { useReducer } from "react";
import { defaultKeyBindings } from "../utils/default-keybindings.js";
import { type HuhuAlignmentLanguage, huhuAlignmentLanguages } from "../utils/huhu-api.js";
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
    huhuAlignmentLanguage: "ja" as HuhuAlignmentLanguage,
    advancedLyricsEnabled: false,
    lineCaptureMode: "standard" as LineCaptureMode,
    lineWaveformAutoAdvance: false,
    lineWaveformPlayAfterSet: false,
    wordCaptureMode: "tap" as WordCaptureMode,
    timingWaveformView: "waveform" as TimingWaveformView,
    timingWaveformZoom: 84,
    timingWaveformAmplitude: 1,
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

const langCodeList = i18n.langCodeList;

const init = (lazyInit: () => string): State => {
    const state: Mutable<State> = { ...initState };

    const languages = navigator.languages || [navigator.language || "en-US"];

    state.lang = languages
        .map((langCode) => {
            if (langCode === "zh") {
                return "zh-CN";
            }
            if (langCode.startsWith("en")) {
                return "en-US";
            }
            return langCode;
        })
        .find((langCode) => langCodeList.includes(langCode)) || "en-US";

    try {
        const storedState = JSON.parse(lazyInit()) as Partial<State> & {
            wordHoldMode?: boolean;
            wordWaveformView?: TimingWaveformView;
            wordWaveformZoom?: number;
            wordWaveformAmplitude?: number;
        };
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
    } catch {
        // It's OK if parsing failed
    }
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
    state.timingWaveformAmplitude = Math.max(0.5, Math.min(4, Number(state.timingWaveformAmplitude) || 1));
    if (!huhuAlignmentLanguages.includes(state.huhuAlignmentLanguage)) {
        state.huhuAlignmentLanguage = "ja";
    }
    return state;
};

export const usePref = (lazyInit: () => string): [State, React.Dispatch<Action>] => useReducer(reducer, lazyInit, init);
