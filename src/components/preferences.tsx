import STRINGS from "#const/strings.json" assert { type: "json" };
import { formatText } from "@lrc-maker/lrc-parser";
import { useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useDismissibleDetails } from "../hooks/useDismissibleDetails.js";
import {
    defaultToolOrder,
    type LineCaptureMode,
    reorderToolOrder,
    targetDropIndex,
    themeColor,
    ThemeMode,
    type ToolId,
    type WordCaptureMode,
} from "../hooks/usePref.js";
import type { ExportLyricFormat, LineLyricExportFormat } from "../utils/advanced-lyrics.js";
import {
    type CloudAiProvider,
    deleteEncryptedApiKey,
    getStoredApiKeySummary,
    loadEncryptedApiKey,
    saveEncryptedApiKey,
    subscribeApiKeyVault,
} from "../utils/ai-key-vault.js";
import {
    type AiEngineMode,
    CloudAiAlignmentError,
    DEFAULT_GEMINI_MODEL,
    DEFAULT_LINE_ALIGN_PROMPT,
    DEFAULT_OPENROUTER_MODEL,
    DEFAULT_WORD_ALIGN_BETA_PROMPT,
    GEMINI_MODEL_OPTIONS,
    OPENROUTER_MODEL_OPTIONS,
    testCloudAiConnection,
} from "../utils/cloud-ai-alignment.js";
import { clearLocalAiCache, stopLocalAiService } from "../utils/local-ai-alignment.js";
import { formatTimeTag } from "../utils/lrc-format.js";
import { unregister } from "../utils/sw.unregister.js";
import { AboutDialog } from "./about.js";
import { appContext } from "./app.context.js";
import { StyledSelect } from "./styled-select.js";
import { toastPubSub } from "./toast.js";
import "toggle-switch-css/src/toggle-switch.css";
import "./preferences.css";

const numberInputProps = { type: "number", step: 1 } as const;

type OnChange<T> = (event: React.ChangeEvent<T>) => void;

type IUseNumberInput<T = HTMLInputElement> = (
    defaultValue: number,
    onChange: OnChange<T>,
) => typeof numberInputProps & {
    ref: React.RefObject<T>;
    onChange: OnChange<T>;
    defaultValue: number;
};

const useNumberInput: IUseNumberInput = (defaultValue: number, onChange) => {
    const ref = useRef<HTMLInputElement>(null);
    useEffect(() => {
        const target = ref.current;
        if (target) {
            const onChange = (): void => {
                target.value = defaultValue.toString();
            };

            target.addEventListener("change", onChange);
            return (): void => target.removeEventListener("change", onChange);
        }
    }, [defaultValue]);

    const $onChange = useCallback(
        (ev: React.ChangeEvent<HTMLInputElement>) => {
            if (ev.target.validity.valid) {
                onChange(ev);
            }
        },
        [onChange],
    );

    return { ...numberInputProps, ref, onChange: $onChange, defaultValue };
};

const langMap = i18n.langMap;

export const Preferences: React.FC = () => {
    const { prefState, prefDispatch, lang } = useContext(appContext);
    const serviceStopDialog = useRef<HTMLDialogElement>(null);
    const colorPopover = useRef<HTMLDetailsElement>(null);
    useDismissibleDetails(colorPopover);
    const aiCacheDialog = useRef<HTMLDialogElement>(null);
    const toolOrderListRef = useRef<HTMLUListElement>(null);
    const [serviceStopping, setServiceStopping] = useState(false);
    const [aiCacheClearing, setAiCacheClearing] = useState(false);
    const [apiKeyDraft, setApiKeyDraft] = useState("");
    const [showApiKey, setShowApiKey] = useState(false);
    const [apiKeyBusy, setApiKeyBusy] = useState(false);
    const [testingConnection, setTestingConnection] = useState(false);
    const [customModelMode, setCustomModelMode] = useState(false);
    const keyVaultSummary = useSyncExternalStore(
        subscribeApiKeyVault,
        getStoredApiKeySummary,
        getStoredApiKeySummary,
    );
    const activeProvider = prefState.aiCloudProvider;
    const activeModelPresets = activeProvider === "gemini" ? GEMINI_MODEL_OPTIONS : OPENROUTER_MODEL_OPTIONS;
    const activeModel = activeProvider === "gemini" ? prefState.aiGeminiModel : prefState.aiOpenRouterModel;
    const isPresetModel = activeModelPresets.some((option) => option.id === activeModel);
    const activeKeyStatus = keyVaultSummary[activeProvider];

    useEffect(() => {
        setApiKeyDraft("");
        setShowApiKey(false);
        setCustomModelMode(false);
    }, [activeProvider]);

    const onSaveApiKey = useCallback(async (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (apiKeyBusy) return;
        const trimmed = apiKeyDraft.trim();
        if (!trimmed) return;
        setApiKeyBusy(true);
        try {
            await saveEncryptedApiKey(activeProvider, trimmed);
            setApiKeyDraft("");
            setShowApiKey(false);
            toastPubSub.pub({ type: "success", text: lang.preferences.aiApiKeySaved });
        } catch {
            toastPubSub.pub({ type: "warning", text: lang.preferences.aiApiKeySaveFailed });
        } finally {
            setApiKeyBusy(false);
        }
    }, [activeProvider, apiKeyBusy, apiKeyDraft, lang.preferences]);

    const onClearApiKey = useCallback(async () => {
        if (apiKeyBusy) return;
        setApiKeyBusy(true);
        try {
            await deleteEncryptedApiKey(activeProvider);
            setApiKeyDraft("");
            toastPubSub.pub({ type: "info", text: lang.preferences.aiApiKeyCleared });
        } finally {
            setApiKeyBusy(false);
        }
    }, [activeProvider, apiKeyBusy, lang.preferences]);

    const onTestApiConnection = useCallback(async () => {
        if (testingConnection) return;
        setTestingConnection(true);
        try {
            const candidateKey = apiKeyDraft.trim() || await loadEncryptedApiKey(activeProvider) || "";
            if (!candidateKey) {
                toastPubSub.pub({ type: "warning", text: lang.preferences.aiApiKeyMissing });
                return;
            }
            await testCloudAiConnection(activeProvider, candidateKey, activeModel);
            toastPubSub.pub({ type: "success", text: lang.preferences.aiConnectionOk });
        } catch (error) {
            const text = error instanceof CloudAiAlignmentError && error.code === "invalid-key"
                ? lang.preferences.aiConnectionInvalidKey
                : lang.preferences.aiConnectionFailed;
            toastPubSub.pub({ type: "warning", text });
        } finally {
            setTestingConnection(false);
        }
    }, [activeModel, activeProvider, apiKeyDraft, lang.preferences, testingConnection]);

    const onActiveModelChange = useCallback((value: string) => {
        if (value === "__custom__") {
            setCustomModelMode(true);
            return;
        }
        setCustomModelMode(false);
        prefDispatch({
            type: activeProvider === "gemini" ? "aiGeminiModel" : "aiOpenRouterModel",
            payload: value,
        });
    }, [activeProvider, prefDispatch]);

    const onCustomModelInput = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
        prefDispatch({
            type: activeProvider === "gemini" ? "aiGeminiModel" : "aiOpenRouterModel",
            payload: event.target.value,
        });
    }, [activeProvider, prefDispatch]);

    const onCustomModelBlur = useCallback((event: React.FocusEvent<HTMLInputElement>) => {
        const trimmed = event.target.value.trim();
        prefDispatch({
            type: activeProvider === "gemini" ? "aiGeminiModel" : "aiOpenRouterModel",
            payload: trimmed || (activeProvider === "gemini" ? DEFAULT_GEMINI_MODEL : DEFAULT_OPENROUTER_MODEL),
        });
    }, [activeProvider, prefDispatch]);
    const [dragTool, setDragTool] = useState<{ toolId: ToolId; fromIndex: number; toIndex: number } | null>(null);
    const dragToolRef = useRef<{ toolId: ToolId; fromIndex: number; toIndex: number } | null>(null);
    dragToolRef.current = dragTool;

    useEffect(() => {
        if (!dragTool) return;
        const onPointerMove = (event: PointerEvent) => {
            const current = dragToolRef.current;
            const list = toolOrderListRef.current;
            if (!current || !list) return;
            const bounds = Array.from(list.children).map((node) => {
                const rect = node.getBoundingClientRect();
                return { top: rect.top, height: rect.height };
            });
            const nextTo = targetDropIndex(bounds, event.clientY);
            if (nextTo !== current.toIndex) {
                setDragTool({ ...current, toIndex: nextTo });
            }
        };
        const finishDrag = (commit: boolean) => {
            const current = dragToolRef.current;
            dragToolRef.current = null;
            setDragTool(null);
            if (commit && current && current.fromIndex !== current.toIndex) {
                prefDispatch({
                    type: "toolOrder",
                    payload: (state) => reorderToolOrder(state.toolOrder, current.fromIndex, current.toIndex),
                });
            }
        };
        const onPointerUp = () => finishDrag(true);
        const onCancel = () => finishDrag(false);
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") finishDrag(false);
        };
        window.addEventListener("pointermove", onPointerMove);
        window.addEventListener("pointerup", onPointerUp);
        window.addEventListener("pointercancel", onCancel);
        window.addEventListener("blur", onCancel);
        window.addEventListener("keydown", onKeyDown);
        return () => {
            window.removeEventListener("pointermove", onPointerMove);
            window.removeEventListener("pointerup", onPointerUp);
            window.removeEventListener("pointercancel", onCancel);
            window.removeEventListener("blur", onCancel);
            window.removeEventListener("keydown", onKeyDown);
        };
    }, [dragTool !== null, prefDispatch]);

    const onColorPick = useCallback(
        (ev: React.ChangeEvent<HTMLInputElement>) => {
            prefDispatch({
                type: "themeColor",
                payload: ev.target.value,
            });
        },
        [prefDispatch],
    );

    const userColorInputText = useRef<HTMLInputElement>(null);

    const onUserInput = useCallback(
        (input: EventTarget & HTMLInputElement) => {
            let value = input.value.toLowerCase();

            if (!input.validity.valid) {
                input.value = input.defaultValue;
                return;
            }

            if (value.length === 3) {
                const [r, g, b] = value;
                value = r + r + g + g + b + b;
            }
            if (value.length < 6) {
                value = value.padEnd(6, "0");
            }

            prefDispatch({
                type: "themeColor",
                payload: "#" + value,
            });
        },
        [prefDispatch],
    );

    const onUserColorInputBlur = useCallback(
        (ev: React.FocusEvent<HTMLInputElement>) => onUserInput(ev.target),
        [onUserInput],
    );

    const onColorSubmit = useCallback(
        (ev: React.FormEvent<HTMLFormElement>) => {
            ev.preventDefault();

            const form = ev.target as HTMLFormElement;

            const input = form.elements.namedItem("user-color-input-text") as HTMLInputElement;

            return onUserInput(input);
        },
        [onUserInput],
    );

    useEffect(() => {
        userColorInputText.current!.value = prefState.themeColor.slice(1);
    }, [prefState.themeColor]);

    const onSpaceChange = useCallback(
        (ev: React.ChangeEvent<HTMLInputElement>) => {
            prefDispatch({
                type: ev.target.name as "spaceStart" & "spaceEnd",
                payload: Number(ev.target.value),
            });
        },
        [prefDispatch],
    );

    const onCacheClear = useCallback(() => {
        void unregister().catch(() => {
            toastPubSub.pub({ type: "warning", text: lang.notify.websiteCacheClearFailed });
        });
    }, [lang.notify.websiteCacheClearFailed]);

    const onSeekStepChange = useCallback(
        (ev: React.ChangeEvent<HTMLInputElement>) => {
            prefDispatch({ type: "seekStepMs", payload: Number(ev.target.value) });
        },
        [prefDispatch],
    );

    const onFineTuneChange = useCallback(
        (ev: React.ChangeEvent<HTMLInputElement>) => {
            prefDispatch({ type: "fineTuneMs", payload: Number(ev.target.value) });
        },
        [prefDispatch],
    );

    const onLangChanged = useCallback(
        (value: string) => {
            prefDispatch({
                type: "lang",
                payload: value,
            });
        },
        [prefDispatch],
    );

    const onBuiltInAudioToggle = useCallback(
        () =>
            prefDispatch({
                type: "builtInAudio",
                payload: (prefState) => !prefState.builtInAudio,
            }),
        [prefDispatch],
    );

    const onShowWaveformToggle = useCallback(
        () =>
            prefDispatch({
                type: "showWaveform",
                payload: (prefState) => !prefState.showWaveform,
            }),
        [prefDispatch],
    );

    const onInteractiveSeekToggle = useCallback(
        () => prefDispatch({ type: "interactiveSeek", payload: (state) => !state.interactiveSeek }),
        [prefDispatch],
    );

    const onLineWaveformAutoAdvanceToggle = useCallback(
        () =>
            prefDispatch({
                type: "lineWaveformAutoAdvance",
                payload: (state) => !state.lineWaveformAutoAdvance,
            }),
        [prefDispatch],
    );

    const onLineWaveformPlayAfterSetToggle = useCallback(
        () =>
            prefDispatch({
                type: "lineWaveformPlayAfterSet",
                payload: (state) => !state.lineWaveformPlayAfterSet,
            }),
        [prefDispatch],
    );

    const onAllowBackgroundAudioToggle = useCallback(
        () => prefDispatch({ type: "allowBackgroundAudio", payload: (state) => !state.allowBackgroundAudio }),
        [prefDispatch],
    );

    const onAiAlignmentToggle = useCallback(
        () => prefDispatch({ type: "aiAlignmentEnabled", payload: (state) => !state.aiAlignmentEnabled }),
        [prefDispatch],
    );

    const onAdvancedLyricsToggle = useCallback(
        () => prefDispatch({ type: "advancedLyricsEnabled", payload: (state) => !state.advancedLyricsEnabled }),
        [prefDispatch],
    );

    const onKeepAiTaskCacheToggle = useCallback(
        () => prefDispatch({ type: "keepAiTaskCache", payload: (state) => !state.keepAiTaskCache }),
        [prefDispatch],
    );

    const onAiGpuAccelerationToggle = useCallback(
        () => prefDispatch({ type: "aiGpuAcceleration", payload: (state) => !state.aiGpuAcceleration }),
        [prefDispatch],
    );

    const onStopAiService = useCallback(async (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (serviceStopping) return;
        setServiceStopping(true);
        try {
            await stopLocalAiService();
            serviceStopDialog.current?.close();
            toastPubSub.pub({ type: "success", text: lang.notify.aiServiceStopped });
        } catch {
            toastPubSub.pub({ type: "warning", text: lang.notify.aiServiceStopFailed });
        } finally {
            setServiceStopping(false);
        }
    }, [lang.notify, serviceStopping]);

    const onClearAiCache = useCallback(async (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (aiCacheClearing) return;
        setAiCacheClearing(true);
        try {
            await clearLocalAiCache();
            aiCacheDialog.current?.close();
            toastPubSub.pub({ type: "success", text: lang.notify.aiCacheCleared });
        } catch {
            toastPubSub.pub({ type: "warning", text: lang.notify.aiCacheClearFailed });
        } finally {
            setAiCacheClearing(false);
        }
    }, [aiCacheClearing, lang.notify]);

    const onScreenButtonToggle = useCallback(
        () =>
            prefDispatch({
                type: "screenButton",
                payload: (prefState) => !prefState.screenButton,
            }),
        [prefDispatch],
    );

    const onThemeModeChange = useCallback(
        (value: string) => {
            prefDispatch({
                type: "themeMode",
                payload: Number.parseInt(value, 10) as ThemeMode,
            });
        },
        [prefDispatch],
    );

    const onFixedChanged = useCallback(
        (value: string) => {
            prefDispatch({
                type: "fixed",
                payload: Number.parseInt(value, 10) as Fixed,
            });
        },
        [prefDispatch],
    );

    const languageOptions = useMemo(() => langMap.map(([value, label]) => ({ value, label })), []);

    const ColorPickerWall = useMemo(() => {
        return Object.values(themeColor).map((color) => {
            const checked = color === prefState.themeColor;
            const classNames = ["color-picker", "ripple"];
            if (checked) {
                classNames.push("checked");
            }
            return (
                <label className={classNames.join(STRINGS.space)} key={color} style={{ backgroundColor: color }}>
                    <input
                        type="radio"
                        name="theme-color"
                        aria-label={`${lang.preferences.themeColor} ${color}`}
                        value={color}
                        checked={checked}
                        onChange={onColorPick}
                    />
                </label>
            );
        });
    }, [lang.preferences.themeColor, onColorPick, prefState.themeColor]);

    const currentThemeColorStyle = useMemo(() => {
        return {
            backgroundColor: prefState.themeColor,
        };
    }, [prefState.themeColor]);

    const formattedText = useMemo(() => {
        return formatText("   hello   世界～   ", prefState.spaceStart, prefState.spaceEnd);
    }, [prefState.spaceStart, prefState.spaceEnd]);

    const aboutDialog = useRef<HTMLDialogElement>(null);

    return (
        <div className="preferences">
            <h1 className="preferences-title">{lang.header.preferences}</h1>
            <ul>
                <li className="preferences-section-title">
                    <h2>{lang.preferences.sections.general}</h2>
                </li>
                <li>
                    <section className="list-item">
                        <span>{lang.preferences.language}</span>
                        <StyledSelect
                            className="preference-select"
                            value={prefState.lang}
                            onValueChange={onLangChanged}
                            label={lang.preferences.language}
                            options={languageOptions}
                        />
                    </section>
                </li>
                <li className="preferences-section-title">
                    <h2>{lang.preferences.sections.media}</h2>
                </li>
                <li>
                    <label className="list-item">
                        <span>{lang.preferences.builtInAudio}</span>
                        <span className="toggle-switch">
                            <input
                                type="checkbox"
                                checked={prefState.builtInAudio}
                                onChange={onBuiltInAudioToggle}
                            />
                            <span className="toggle-switch-label" />
                        </span>
                    </label>
                </li>
                <li>
                    <label className="list-item">
                        <span>{lang.preferences.allowBackgroundAudio}</span>
                        <span className="toggle-switch">
                            <input
                                type="checkbox"
                                checked={prefState.allowBackgroundAudio}
                                onChange={onAllowBackgroundAudioToggle}
                            />
                            <span className="toggle-switch-label" />
                        </span>
                    </label>
                </li>
                <li className="preferences-section-title">
                    <h2>{lang.preferences.sections.timing}</h2>
                </li>
                <li>
                    <label className="list-item">
                        <span>{lang.preferences.spaceButton}</span>
                        <span className="toggle-switch">
                            <input
                                type="checkbox"
                                checked={prefState.screenButton}
                                onChange={onScreenButtonToggle}
                            />
                            <span className="toggle-switch-label" />
                        </span>
                    </label>
                </li>
                <li>
                    <label className="list-item">
                        <span>{lang.preferences.showWaveform}</span>
                        <span className="toggle-switch">
                            <input
                                type="checkbox"
                                checked={prefState.showWaveform}
                                onChange={onShowWaveformToggle}
                            />
                            <span className="toggle-switch-label" />
                        </span>
                    </label>
                </li>
                <li>
                    <label className="list-item">
                        <span>{lang.preferences.interactiveSeek}</span>
                        <span className="toggle-switch">
                            <input
                                type="checkbox"
                                checked={prefState.interactiveSeek}
                                onChange={onInteractiveSeekToggle}
                            />
                            <span className="toggle-switch-label" />
                        </span>
                    </label>
                </li>
                <li>
                    <label className="list-item">
                        <span>{lang.preferences.lineWaveformAutoAdvance}</span>
                        <span className="toggle-switch">
                            <input
                                type="checkbox"
                                checked={prefState.lineWaveformAutoAdvance}
                                onChange={onLineWaveformAutoAdvanceToggle}
                            />
                            <span className="toggle-switch-label" />
                        </span>
                    </label>
                </li>
                <li>
                    <label className="list-item">
                        <span>{lang.preferences.lineWaveformPlayAfterSet}</span>
                        <span className="toggle-switch">
                            <input
                                type="checkbox"
                                checked={prefState.lineWaveformPlayAfterSet}
                                onChange={onLineWaveformPlayAfterSetToggle}
                            />
                            <span className="toggle-switch-label" />
                        </span>
                    </label>
                </li>
                <li className="preferences-section-title">
                    <h2>{lang.preferences.sections.advanced}</h2>
                </li>
                <li>
                    <label className="list-item">
                        <span>{lang.advancedLyrics.setting}</span>
                        <span className="toggle-switch">
                            <input
                                type="checkbox"
                                checked={prefState.advancedLyricsEnabled}
                                onChange={onAdvancedLyricsToggle}
                            />
                            <span className="toggle-switch-label" />
                        </span>
                    </label>
                </li>
                <li>
                    <section className="list-item">
                        <span>{lang.preferences.aiEngine}</span>
                        <StyledSelect
                            className="preference-select"
                            value={prefState.aiEngine}
                            onValueChange={(value) =>
                                prefDispatch({ type: "aiEngine", payload: value as AiEngineMode })}
                            label={lang.preferences.aiEngine}
                            options={[
                                { value: "cloud", label: lang.preferences.aiEngineCloud },
                                { value: "local", label: lang.preferences.aiEngineLocal },
                            ]}
                        />
                    </section>
                </li>
                {prefState.aiEngine === "cloud"
                    ? (
                        <>
                            <li>
                                <section className="list-item">
                                    <span>{lang.preferences.aiProvider}</span>
                                    <StyledSelect
                                        className="preference-select"
                                        value={prefState.aiCloudProvider}
                                        onValueChange={(value) =>
                                            prefDispatch({
                                                type: "aiCloudProvider",
                                                payload: value as CloudAiProvider,
                                            })}
                                        label={lang.preferences.aiProvider}
                                        options={[
                                            { value: "gemini", label: lang.preferences.aiProviderGemini },
                                            { value: "openrouter", label: lang.preferences.aiProviderOpenRouter },
                                        ]}
                                    />
                                </section>
                            </li>
                            <li>
                                <section className="list-item preferences-ai-model-row">
                                    <span>{lang.preferences.aiModel}</span>
                                    <div className="preferences-ai-model-controls">
                                        <StyledSelect
                                            className="preference-select"
                                            value={customModelMode || !isPresetModel ? "__custom__" : activeModel}
                                            onValueChange={onActiveModelChange}
                                            label={lang.preferences.aiModel}
                                            options={[
                                                ...activeModelPresets.map((option) => ({
                                                    value: option.id,
                                                    label: option.label,
                                                })),
                                                { value: "__custom__", label: lang.preferences.aiModelCustom },
                                            ]}
                                        />
                                        {(customModelMode || !isPresetModel) && (
                                            <input
                                                type="text"
                                                className="preferences-text-input"
                                                aria-label={lang.preferences.aiModelCustom}
                                                value={activeModel}
                                                onChange={onCustomModelInput}
                                                onBlur={onCustomModelBlur}
                                                placeholder={activeProvider === "gemini"
                                                    ? DEFAULT_GEMINI_MODEL
                                                    : DEFAULT_OPENROUTER_MODEL}
                                                autoCapitalize="none"
                                                autoComplete="off"
                                                autoCorrect="off"
                                                spellCheck={false}
                                            />
                                        )}
                                    </div>
                                </section>
                            </li>
                            <li>
                                <label className="list-item">
                                    <span>{lang.preferences.aiThinking}</span>
                                    <span className="toggle-switch">
                                        <input
                                            type="checkbox"
                                            checked={prefState.aiCloudThinking}
                                            onChange={() =>
                                                prefDispatch({
                                                    type: "aiCloudThinking",
                                                    payload: (state) => !state.aiCloudThinking,
                                                })}
                                        />
                                        <span className="toggle-switch-label" />
                                    </span>
                                </label>
                            </li>
                            <li>
                                <section className="list-item preferences-ai-key-block">
                                    <header className="preferences-ai-key-header">
                                        <div>
                                            <strong>{lang.preferences.aiApiKey}</strong>
                                            <span>{lang.preferences.aiApiKeyHint}</span>
                                        </div>
                                        <span
                                            className={`preferences-ai-key-badge${
                                                activeKeyStatus.configured ? " is-saved" : ""
                                            }`}
                                        >
                                            {activeKeyStatus.configured
                                                ? lang.preferences.aiApiKeyConfigured
                                                : lang.preferences.aiApiKeyUnconfigured}
                                        </span>
                                    </header>
                                    <form className="preferences-ai-key-form" onSubmit={onSaveApiKey}>
                                        <input
                                            type={showApiKey ? "text" : "password"}
                                            className="preferences-text-input preferences-api-key-input"
                                            value={apiKeyDraft}
                                            onChange={(event) => setApiKeyDraft(event.target.value)}
                                            placeholder={activeKeyStatus.configured
                                                ? lang.preferences.aiApiKeyReplacePlaceholder
                                                : lang.preferences.aiApiKeyPlaceholder}
                                            aria-label={lang.preferences.aiApiKey}
                                            autoCapitalize="none"
                                            autoComplete="new-password"
                                            autoCorrect="off"
                                            spellCheck={false}
                                        />
                                        <div className="preferences-ai-key-actions">
                                            <button
                                                type="button"
                                                className="preferences-inline-btn"
                                                onClick={() => setShowApiKey((prev) => !prev)}
                                                disabled={!apiKeyDraft}
                                            >
                                                {showApiKey
                                                    ? lang.preferences.aiApiKeyHide
                                                    : lang.preferences.aiApiKeyShow}
                                            </button>
                                            <button
                                                type="submit"
                                                className="preferences-inline-btn is-primary"
                                                disabled={apiKeyBusy || !apiKeyDraft.trim()}
                                            >
                                                {lang.preferences.aiApiKeySave}
                                            </button>
                                            <button
                                                type="button"
                                                className="preferences-inline-btn"
                                                disabled={testingConnection
                                                    || (!apiKeyDraft.trim() && !activeKeyStatus.configured)}
                                                onClick={() => void onTestApiConnection()}
                                            >
                                                {testingConnection
                                                    ? lang.preferences.aiConnectionTesting
                                                    : lang.preferences.aiConnectionTest}
                                            </button>
                                            {activeKeyStatus.configured && (
                                                <button
                                                    type="button"
                                                    className="preferences-inline-btn is-danger"
                                                    disabled={apiKeyBusy}
                                                    onClick={() => void onClearApiKey()}
                                                >
                                                    {lang.preferences.aiApiKeyClear}
                                                </button>
                                            )}
                                        </div>
                                    </form>
                                </section>
                            </li>
                            <li>
                                <details className="list-item preferences-ai-prompts">
                                    <summary>
                                        <div>
                                            <strong>{lang.preferences.aiPromptsTitle}</strong>
                                            <span>{lang.preferences.aiPromptsHint}</span>
                                        </div>
                                    </summary>
                                    <div className="preferences-ai-prompts-body">
                                        <div className="preferences-prompt-field">
                                            <header>
                                                <label htmlFor="pref-ai-line-prompt">
                                                    {lang.preferences.aiLinePromptLabel}
                                                </label>
                                                <button
                                                    type="button"
                                                    className="preferences-inline-btn"
                                                    disabled={!prefState.aiLinePrompt}
                                                    onClick={() => prefDispatch({ type: "aiLinePrompt", payload: "" })}
                                                >
                                                    {lang.preferences.aiPromptReset}
                                                </button>
                                            </header>
                                            <textarea
                                                id="pref-ai-line-prompt"
                                                rows={8}
                                                value={prefState.aiLinePrompt || DEFAULT_LINE_ALIGN_PROMPT}
                                                onChange={(event) =>
                                                    prefDispatch({
                                                        type: "aiLinePrompt",
                                                        payload: event.target.value === DEFAULT_LINE_ALIGN_PROMPT
                                                            ? ""
                                                            : event.target.value,
                                                    })}
                                                spellCheck={false}
                                            />
                                        </div>
                                        <div className="preferences-prompt-field">
                                            <header>
                                                <label htmlFor="pref-ai-word-prompt">
                                                    {lang.preferences.aiWordPromptLabel}
                                                </label>
                                                <button
                                                    type="button"
                                                    className="preferences-inline-btn"
                                                    disabled={!prefState.aiWordPrompt}
                                                    onClick={() => prefDispatch({ type: "aiWordPrompt", payload: "" })}
                                                >
                                                    {lang.preferences.aiPromptReset}
                                                </button>
                                            </header>
                                            <textarea
                                                id="pref-ai-word-prompt"
                                                rows={8}
                                                value={prefState.aiWordPrompt || DEFAULT_WORD_ALIGN_BETA_PROMPT}
                                                onChange={(event) =>
                                                    prefDispatch({
                                                        type: "aiWordPrompt",
                                                        payload: event.target.value === DEFAULT_WORD_ALIGN_BETA_PROMPT
                                                            ? ""
                                                            : event.target.value,
                                                    })}
                                                spellCheck={false}
                                            />
                                        </div>
                                    </div>
                                </details>
                            </li>
                        </>
                    )
                    : (
                        <>
                            <li>
                                <label className="list-item">
                                    <span>{lang.preferences.aiAlignment}</span>
                                    <span className="toggle-switch">
                                        <input
                                            type="checkbox"
                                            checked={prefState.aiAlignmentEnabled}
                                            onChange={onAiAlignmentToggle}
                                        />
                                        <span className="toggle-switch-label" />
                                    </span>
                                </label>
                            </li>
                            <li>
                                <label className="list-item">
                                    <span>{lang.preferences.aiGpuAcceleration}</span>
                                    <span className="toggle-switch">
                                        <input
                                            type="checkbox"
                                            checked={prefState.aiGpuAcceleration}
                                            onChange={onAiGpuAccelerationToggle}
                                        />
                                        <span className="toggle-switch-label" />
                                    </span>
                                </label>
                            </li>
                            <li>
                                <label className="list-item">
                                    <span>{lang.preferences.keepAiTaskCache}</span>
                                    <span className="toggle-switch">
                                        <input
                                            type="checkbox"
                                            checked={prefState.keepAiTaskCache}
                                            onChange={onKeepAiTaskCacheToggle}
                                        />
                                        <span className="toggle-switch-label" />
                                    </span>
                                </label>
                            </li>
                            <li className="ripple">
                                <button
                                    className="list-item preferences-button"
                                    type="button"
                                    onClick={() => aiCacheDialog.current?.showModal()}
                                >
                                    {lang.preferences.aiClearCache}
                                </button>
                            </li>
                            <li className="ripple">
                                <button
                                    className="list-item preferences-button"
                                    type="button"
                                    onClick={() => serviceStopDialog.current?.showModal()}
                                >
                                    {lang.preferences.aiStopService}
                                </button>
                            </li>
                        </>
                    )}
                <li className="preferences-section-title">
                    <h2>{lang.preferences.sections.appearance}</h2>
                </li>
                <li>
                    <section className="list-item">
                        <span>{lang.preferences.themeMode.label}</span>
                        <StyledSelect
                            className="preference-select"
                            name="theme-mode"
                            value={prefState.themeMode}
                            onValueChange={onThemeModeChange}
                            label={lang.preferences.themeMode.label}
                            options={[
                                { value: ThemeMode.auto, label: lang.preferences.themeMode.auto },
                                { value: ThemeMode.light, label: lang.preferences.themeMode.light },
                                { value: ThemeMode.dark, label: lang.preferences.themeMode.dark },
                            ]}
                        />
                    </section>
                </li>

                <li>
                    <section className="list-item">
                        <span>{lang.preferences.themeColor}</span>
                        <details
                            className="dropdown"
                            ref={colorPopover}
                            onKeyDown={(event) => {
                                if (event.key !== "Escape") return;
                                event.preventDefault();
                                event.stopPropagation();
                                event.currentTarget.open = false;
                                event.currentTarget.querySelector("summary")?.focus();
                            }}
                        >
                            <summary>
                                <span className="color-picker ripple hash" style={currentThemeColorStyle}>
                                    {"#"}
                                </span>
                                <span className="current-theme-color">{prefState.themeColor.slice(1)}</span>
                            </summary>
                            <form className="dropdown-body color-wall" onSubmit={onColorSubmit}>
                                {ColorPickerWall}
                                <label
                                    className="color-picker ripple user-color-label hash"
                                    style={currentThemeColorStyle}
                                >
                                    {"#"}
                                    <input
                                        type="color"
                                        className="native-color-input"
                                        aria-label={lang.visual.customColor}
                                        value={prefState.themeColor}
                                        onChange={onColorPick}
                                    />
                                </label>
                                <input
                                    ref={userColorInputText}
                                    id="user-color-input-text"
                                    name="user-color-input-text"
                                    className="user-color-input-text"
                                    type="text"
                                    pattern="[\da-fA-F]{3}|[\da-fA-F]{6}"
                                    aria-label={`${lang.visual.customColor} (HEX)`}
                                    required={true}
                                    autoCapitalize="none"
                                    autoComplete="off"
                                    autoCorrect="off"
                                    spellCheck={false}
                                    defaultValue={prefState.themeColor.slice(1)}
                                    onBlur={onUserColorInputBlur}
                                />
                            </form>
                        </details>
                    </section>
                </li>
                <li>
                    <section className="list-item">
                        <span>{lang.preferences.lrcFormat}</span>
                        <span>
                            <time className="format-example-time">{formatTimeTag(83.456, prefState.fixed)}</time>
                            <span className="format-example-text">{formattedText}</span>
                        </span>
                    </section>
                </li>
                <li>
                    <section className="list-item">
                        <span>{lang.preferences.fixed}</span>
                        <StyledSelect
                            className="precision-select"
                            name="fixed"
                            value={prefState.fixed}
                            onValueChange={onFixedChanged}
                            label={lang.preferences.fixed}
                            options={[0, 1, 2, 3].map((value) => ({ value, label: String(value) }))}
                        />
                    </section>
                </li>
                <li>
                    <label className="list-item" htmlFor="space-start">
                        <span>{lang.preferences.leftSpace}</span>
                        <input
                            name="spaceStart"
                            id="space-start"
                            required={true}
                            min={-1}
                            {...useNumberInput(prefState.spaceStart, onSpaceChange)}
                        />
                    </label>
                </li>
                <li>
                    <label className="list-item" htmlFor="space-end">
                        <span>{lang.preferences.rightSpace}</span>
                        <input
                            name="spaceEnd"
                            id="space-end"
                            required={true}
                            min={-1}
                            {...useNumberInput(prefState.spaceEnd, onSpaceChange)}
                        />
                    </label>
                </li>
                <li className="preferences-section-title">
                    <h2>{lang.preferences.sections.precision}</h2>
                </li>
                <li>
                    <label className="list-item" htmlFor="seek-step-ms">
                        <span>{lang.preferences.seekStepMs}</span>
                        <input
                            name="seekStepMs"
                            id="seek-step-ms"
                            required={true}
                            min={100}
                            max={30000}
                            {...useNumberInput(prefState.seekStepMs, onSeekStepChange)}
                        />
                    </label>
                </li>
                <li>
                    <label className="list-item" htmlFor="fine-tune-ms">
                        <span>{lang.preferences.fineTuneMs}</span>
                        <input
                            name="fineTuneMs"
                            id="fine-tune-ms"
                            required={true}
                            min={10}
                            max={5000}
                            {...useNumberInput(prefState.fineTuneMs, onFineTuneChange)}
                        />
                    </label>
                </li>
                <li className="preferences-section-title">
                    <h2>{lang.preferences.sections.defaults}</h2>
                </li>
                <li>
                    <div className="list-item">
                        <span>{lang.preferences.defaultLineExportFormat}</span>
                        <StyledSelect
                            value={prefState.defaultLineExportFormat}
                            onValueChange={(value) =>
                                prefDispatch({
                                    type: "defaultLineExportFormat",
                                    payload: value as LineLyricExportFormat,
                                })}
                            label={lang.preferences.defaultLineExportFormat}
                            options={[
                                { value: "lrc", label: lang.advancedLyrics.standardLrcDefault },
                                { value: "srt", label: lang.advancedLyrics.lineSrt },
                                { value: "ttml", label: lang.advancedLyrics.lineTtml },
                                { value: "txt", label: lang.advancedLyrics.plainText },
                            ]}
                        />
                    </div>
                </li>
                <li>
                    <div className="list-item">
                        <span>{lang.preferences.defaultWordExportFormat}</span>
                        <StyledSelect
                            value={prefState.defaultWordExportFormat}
                            onValueChange={(value) =>
                                prefDispatch({
                                    type: "defaultWordExportFormat",
                                    payload: value as ExportLyricFormat,
                                })}
                            label={lang.preferences.defaultWordExportFormat}
                            options={[
                                { value: "enhanced-lrc", label: lang.advancedLyrics.enhancedLrcDefault },
                                { value: "lrc", label: lang.advancedLyrics.standardLrc },
                                { value: "krc", label: "KRC" },
                                { value: "ttml", label: lang.advancedLyrics.wordTtml },
                                { value: "ass-kf", label: lang.advancedLyrics.assKf },
                                { value: "srt", label: lang.advancedLyrics.lineSrt },
                            ]}
                        />
                    </div>
                </li>
                <li>
                    <div className="list-item">
                        <span>{lang.preferences.defaultLineCaptureMode}</span>
                        <StyledSelect
                            value={prefState.lineCaptureMode}
                            onValueChange={(value) =>
                                prefDispatch({
                                    type: "lineCaptureMode",
                                    payload: value as LineCaptureMode,
                                })}
                            label={lang.preferences.defaultLineCaptureMode}
                            options={[
                                { value: "standard", label: lang.timing.standardCaptureMode },
                                { value: "waveform", label: lang.timing.waveformCaptureMode },
                            ]}
                        />
                    </div>
                </li>
                <li>
                    <div className="list-item">
                        <span>{lang.preferences.defaultWordCaptureMode}</span>
                        <StyledSelect
                            value={prefState.wordCaptureMode}
                            onValueChange={(value) =>
                                prefDispatch({
                                    type: "wordCaptureMode",
                                    payload: value as WordCaptureMode,
                                })}
                            label={lang.preferences.defaultWordCaptureMode}
                            options={[
                                { value: "tap", label: lang.advancedLyrics.tapMode },
                                { value: "hold", label: lang.advancedLyrics.holdMode },
                                { value: "waveform", label: lang.advancedLyrics.waveformMode },
                            ]}
                        />
                    </div>
                </li>
                <li>
                    <section className="list-item preferences-tool-order">
                        <header>
                            <div>
                                <strong>{lang.preferences.toolOrder}</strong>
                                <span>{lang.preferences.toolOrderHint}</span>
                            </div>
                            <button
                                type="button"
                                className="preferences-order-reset"
                                onClick={() => prefDispatch({ type: "toolOrder", payload: [...defaultToolOrder] })}
                            >
                                {lang.preferences.resetOrder}
                            </button>
                        </header>
                        <ul ref={toolOrderListRef} className={dragTool ? "is-dragging-list" : undefined}>
                            {(dragTool
                                ? reorderToolOrder(prefState.toolOrder, dragTool.fromIndex, dragTool.toIndex)
                                : prefState.toolOrder).map((toolId, index) => {
                                    const toolNames: Record<ToolId, string> = {
                                        overwrite: lang.tools.overwrite,
                                        "timeline-fix": lang.tools.timelineFix,
                                        time: lang.tools.changeOffset,
                                        split: lang.tools.splitTranslation,
                                        convert: lang.tools.formatConverter,
                                        "remove-tags": lang.tools.removeTags,
                                        "remove-empty": lang.tools.removeEmpty,
                                        sections: lang.tools.sections,
                                        tracklist: lang.tools.tracklist,
                                        replace: lang.tools.replaceText,
                                        case: lang.tools.caseConverter,
                                    };
                                    const moveTool = (targetIndex: number) => {
                                        prefDispatch({
                                            type: "toolOrder",
                                            payload: (state) => reorderToolOrder(state.toolOrder, index, targetIndex),
                                        });
                                    };
                                    const isDragging = dragTool?.toolId === toolId;
                                    const startDrag = (event: React.PointerEvent<HTMLElement>) => {
                                        if (event.pointerType === "mouse" && event.button !== 0) return;
                                        if ((event.target as HTMLElement).closest("button")) return;
                                        event.preventDefault();
                                        const fromIndex = prefState.toolOrder.indexOf(toolId);
                                        if (fromIndex < 0) return;
                                        setDragTool({ toolId, fromIndex, toIndex: fromIndex });
                                    };
                                    return (
                                        <li
                                            key={toolId}
                                            className={isDragging ? "is-dragging" : undefined}
                                            onPointerDown={startDrag}
                                        >
                                            <span className="preferences-order-handle" aria-hidden="true">⋮⋮</span>
                                            <span className="preferences-order-index">{index + 1}</span>
                                            <strong>{toolNames[toolId]}</strong>
                                            <div className="preferences-order-actions">
                                                <button
                                                    type="button"
                                                    disabled={index === 0}
                                                    onClick={() => moveTool(0)}
                                                >
                                                    {lang.preferences.pinTop}
                                                </button>
                                                <button
                                                    type="button"
                                                    disabled={index === 0}
                                                    onClick={() => moveTool(index - 1)}
                                                >
                                                    {lang.preferences.moveUp}
                                                </button>
                                                <button
                                                    type="button"
                                                    disabled={index === prefState.toolOrder.length - 1}
                                                    onClick={() => moveTool(index + 1)}
                                                >
                                                    {lang.preferences.moveDown}
                                                </button>
                                            </div>
                                        </li>
                                    );
                                })}
                        </ul>
                    </section>
                </li>
                <li className="preferences-section-title">
                    <h2>{lang.preferences.sections.storage}</h2>
                </li>
                <li className="ripple">
                    <button className="list-item preferences-button" type="button" onClick={onCacheClear}>
                        {lang.preferences.clearCache}
                    </button>
                </li>
                <li className="ripple">
                    <button
                        className="list-item preferences-button"
                        type="button"
                        onClick={() => aboutDialog.current?.showModal()}
                    >
                        {lang.about.button}
                    </button>
                </li>
            </ul>
            <dialog
                className="about-dialog service-stop-dialog"
                ref={aiCacheDialog}
                aria-labelledby="ai-cache-dialog-title"
                onCancel={(event) => {
                    if (aiCacheClearing) event.preventDefault();
                }}
            >
                <article>
                    <h2 id="ai-cache-dialog-title">{lang.preferences.aiClearCacheTitle}</h2>
                    <p>{lang.preferences.aiClearCacheConfirm}</p>
                    <form onSubmit={onClearAiCache}>
                        <button
                            type="button"
                            className="button service-stop-cancel"
                            disabled={aiCacheClearing}
                            onClick={() => aiCacheDialog.current?.close()}
                        >
                            {lang.preferences.aiStopServiceCancel}
                        </button>
                        <button type="submit" className="button" disabled={aiCacheClearing}>
                            {lang.preferences.aiClearCacheAction}
                        </button>
                    </form>
                </article>
            </dialog>
            <dialog
                className="about-dialog service-stop-dialog"
                ref={serviceStopDialog}
                aria-labelledby="service-stop-dialog-title"
                onCancel={(event) => {
                    if (serviceStopping) event.preventDefault();
                }}
            >
                <article>
                    <h2 id="service-stop-dialog-title">{lang.preferences.aiStopServiceTitle}</h2>
                    <p>{lang.preferences.aiStopServiceConfirm}</p>
                    <form onSubmit={onStopAiService}>
                        <button
                            type="button"
                            className="button service-stop-cancel"
                            disabled={serviceStopping}
                            onClick={() => serviceStopDialog.current?.close()}
                        >
                            {lang.preferences.aiStopServiceCancel}
                        </button>
                        <button type="submit" className="button" disabled={serviceStopping}>
                            {lang.preferences.aiStopServiceAction}
                        </button>
                    </form>
                </article>
            </dialog>
            <AboutDialog dialogRef={aboutDialog} lang={lang} />
        </div>
    );
};
