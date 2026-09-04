import STRINGS from "#const/strings.json" assert { type: "json" };
import { convertTimeToTag, formatText } from "@lrc-maker/lrc-parser";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { themeColor, ThemeMode } from "../hooks/usePref.js";
import {
    checkHuhuAlignmentCapability,
    HuhuApiError,
    type HuhuCapability,
    type HuhuLanguageSelection,
    isHuhuBrowserOriginAllowed,
} from "../utils/huhu-api.js";
import { clearHuhuApiKey, hasHuhuApiKey, readHuhuApiKey, saveHuhuApiKey } from "../utils/huhu-secret-store.js";
import { clearLocalAiCache, stopLocalAiService } from "../utils/local-ai-alignment.js";
import { unregister } from "../utils/sw.unregister.js";
import { AboutDialog } from "./about.js";
import { appContext, ChangBits } from "./app.context.js";
import { toastPubSub } from "./toast.js";

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
type HuhuSettingsStatus =
    | { kind: "available"; capability: HuhuCapability }
    | { kind: "cleared" | "cors" | "denied" | "failed" | "invalid-key" | "saved"; reason?: string };

export const Preferences: React.FC = () => {
    const { prefState, prefDispatch, lang } = useContext(appContext, ChangBits.lang | ChangBits.prefState);
    const serviceStopDialog = useRef<HTMLDialogElement>(null);
    const aiCacheDialog = useRef<HTMLDialogElement>(null);
    const [serviceStopping, setServiceStopping] = useState(false);
    const [aiCacheClearing, setAiCacheClearing] = useState(false);
    const [huhuKeyStored, setHuhuKeyStored] = useState<boolean | null>(null);
    const [huhuKeyBusy, setHuhuKeyBusy] = useState(false);
    const [huhuStatus, setHuhuStatus] = useState<HuhuSettingsStatus | null>(null);
    const huhuKeyInput = useRef<HTMLInputElement>(null);
    const huhuOriginAvailable = import.meta.env.DEV || isHuhuBrowserOriginAllowed(location.origin);

    useEffect(() => {
        let active = true;
        void hasHuhuApiKey().then((stored) => {
            if (active) setHuhuKeyStored(stored);
        }).catch(() => {
            if (active) {
                setHuhuKeyStored(false);
                setHuhuStatus({ kind: "failed" });
            }
        });
        return () => {
            active = false;
        };
    }, []);

    const onHuhuKeySave = useCallback(async (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (huhuKeyBusy || !huhuOriginAvailable) return;
        const apiKey = huhuKeyInput.current?.value.trim() || "";
        if (!apiKey) return;
        setHuhuKeyBusy(true);
        try {
            await saveHuhuApiKey(apiKey);
            if (huhuKeyInput.current) huhuKeyInput.current.value = "";
            setHuhuKeyStored(true);
            setHuhuStatus({ kind: "saved" });
        } catch {
            setHuhuStatus({ kind: "failed" });
        } finally {
            setHuhuKeyBusy(false);
        }
    }, [huhuKeyBusy, huhuOriginAvailable]);

    const onHuhuKeyClear = useCallback(async () => {
        if (huhuKeyBusy) return;
        setHuhuKeyBusy(true);
        try {
            await clearHuhuApiKey();
            if (huhuKeyInput.current) huhuKeyInput.current.value = "";
            setHuhuKeyStored(false);
            setHuhuStatus({ kind: "cleared" });
        } catch {
            setHuhuStatus({ kind: "failed" });
        } finally {
            setHuhuKeyBusy(false);
        }
    }, [huhuKeyBusy]);

    const onHuhuCapabilityCheck = useCallback(async () => {
        if (huhuKeyBusy || !huhuOriginAvailable) return;
        setHuhuKeyBusy(true);
        try {
            const apiKey = await readHuhuApiKey();
            if (!apiKey) {
                setHuhuKeyStored(false);
                setHuhuStatus(null);
                return;
            }
            const capability = await checkHuhuAlignmentCapability(apiKey);
            setHuhuStatus(
                capability.available
                    ? { kind: "available", capability }
                    : { kind: "denied", reason: capability.reason },
            );
        } catch (error) {
            const kind = error instanceof HuhuApiError && error.code === "cors"
                ? "cors"
                : error instanceof HuhuApiError && error.code === "invalid-key"
                ? "invalid-key"
                : "failed";
            setHuhuStatus({ kind });
        } finally {
            setHuhuKeyBusy(false);
        }
    }, [huhuKeyBusy, huhuOriginAvailable]);

    const onHuhuLanguageChange = useCallback((event: React.ChangeEvent<HTMLSelectElement>) => {
        prefDispatch({
            type: "huhuAlignmentLanguage",
            payload: event.currentTarget.value as HuhuLanguageSelection,
        });
    }, [prefDispatch]);

    const huhuStatusText = useMemo(() => {
        if (!huhuOriginAvailable) return lang.preferences.huhuCorsBlocked;
        if (huhuKeyStored === null && !huhuStatus) return lang.preferences.huhuWorking;
        if (!huhuStatus) return huhuKeyStored ? lang.preferences.huhuKeySaved : lang.preferences.huhuKeyNotSaved;
        if (huhuStatus.kind === "saved") return lang.preferences.huhuKeySaved;
        if (huhuStatus.kind === "cleared") return lang.preferences.huhuKeyCleared;
        if (huhuStatus.kind === "cors") return lang.preferences.huhuCorsBlocked;
        if (huhuStatus.kind === "invalid-key") return lang.preferences.huhuInvalidKey;
        if (huhuStatus.kind === "denied") {
            return lang.preferences.huhuPermissionDenied.replace("%s", huhuStatus.reason || "not_granted");
        }
        if (huhuStatus.kind === "failed") return lang.preferences.huhuKeyOperationFailed;
        if (huhuStatus.kind !== "available") return lang.preferences.huhuKeyOperationFailed;
        const requests = huhuStatus.capability.cycleRequests;
        if (!requests || requests.limit === null || requests.remaining === null) {
            return lang.preferences.huhuCapabilityUnlimited;
        }
        return lang.preferences.huhuCapabilityQuota
            .replace("%used", requests.used.toString())
            .replace("%pending", requests.pending.toString())
            .replace("%remaining", requests.remaining.toString())
            .replace("%limit", requests.limit.toString());
    }, [huhuKeyStored, huhuOriginAvailable, huhuStatus, lang.preferences]);

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
            let value = input.value;

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
        (ev: React.ChangeEvent<HTMLSelectElement>) => {
            prefDispatch({
                type: "lang",
                payload: ev.target.value,
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
        (ev: React.ChangeEvent<HTMLSelectElement>) => {
            prefDispatch({
                type: "themeMode",
                payload: Number.parseInt(ev.target.value, 10) as ThemeMode,
            });
        },
        [prefDispatch],
    );

    const onFixedChanged = useCallback(
        (ev: React.ChangeEvent<HTMLSelectElement>) => {
            prefDispatch({
                type: "fixed",
                payload: Number.parseInt(ev.target.value, 10) as Fixed,
            });
        },
        [prefDispatch],
    );

    const LangOptionList = useMemo(() => {
        return langMap.map(([code, display]) => {
            return (
                <option key={code} value={code}>
                    {display}
                </option>
            );
        });
    }, []);

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
                        hidden={true}
                        type="radio"
                        name="theme-color"
                        value={color}
                        checked={checked}
                        onChange={onColorPick}
                    />
                </label>
            );
        });
    }, [onColorPick, prefState.themeColor]);

    const currentThemeColorStyle = useMemo(() => {
        return {
            backgroundColor: prefState.themeColor,
        };
    }, [prefState.themeColor]);

    const formattedText = useMemo(() => {
        return formatText("   hello   世界～   ", prefState.spaceStart, prefState.spaceEnd);
    }, [prefState.spaceStart, prefState.spaceEnd]);

    const userColorLabel = useRef<HTMLLabelElement>(null);
    const userColorInput = useRef<HTMLInputElement>(null);
    const aboutDialog = useRef<HTMLDialogElement>(null);

    useEffect(() => {
        if (userColorInput.current!.type === "color") {
            userColorLabel.current!.removeAttribute("for");
        }
    }, []);

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
                        <div className="option-select">
                            <select
                                value={prefState.lang}
                                onChange={onLangChanged}
                                aria-label={lang.preferences.language}
                            >
                                {LangOptionList}
                            </select>
                        </div>
                    </section>
                </li>
                <li className="preferences-section-title">
                    <h2>{lang.preferences.sections.media}</h2>
                </li>
                <li>
                    <label className="list-item">
                        <span>{lang.preferences.builtInAudio}</span>
                        <label className="toggle-switch">
                            <input
                                type="checkbox"
                                checked={prefState.builtInAudio}
                                onChange={onBuiltInAudioToggle}
                                aria-label={lang.preferences.builtInAudio}
                            />
                            <span className="toggle-switch-label" />
                        </label>
                    </label>
                </li>
                <li>
                    <label className="list-item">
                        <span>{lang.preferences.allowBackgroundAudio}</span>
                        <label className="toggle-switch">
                            <input
                                type="checkbox"
                                checked={prefState.allowBackgroundAudio}
                                onChange={onAllowBackgroundAudioToggle}
                                aria-label={lang.preferences.allowBackgroundAudio}
                            />
                            <span className="toggle-switch-label" />
                        </label>
                    </label>
                </li>
                <li className="preferences-section-title">
                    <h2>{lang.preferences.sections.timing}</h2>
                </li>
                <li>
                    <label className="list-item">
                        <span>{lang.preferences.spaceButton}</span>
                        <label className="toggle-switch">
                            <input
                                type="checkbox"
                                checked={prefState.screenButton}
                                onChange={onScreenButtonToggle}
                                aria-label={lang.preferences.spaceButton}
                            />
                            <span className="toggle-switch-label" />
                        </label>
                    </label>
                </li>
                <li>
                    <label className="list-item">
                        <span>{lang.preferences.showWaveform}</span>
                        <label className="toggle-switch">
                            <input
                                type="checkbox"
                                checked={prefState.showWaveform}
                                onChange={onShowWaveformToggle}
                                aria-label={lang.preferences.showWaveform}
                            />
                            <span className="toggle-switch-label" />
                        </label>
                    </label>
                </li>
                <li>
                    <label className="list-item">
                        <span>{lang.preferences.interactiveSeek}</span>
                        <label className="toggle-switch">
                            <input
                                type="checkbox"
                                checked={prefState.interactiveSeek}
                                onChange={onInteractiveSeekToggle}
                                aria-label={lang.preferences.interactiveSeek}
                            />
                            <span className="toggle-switch-label" />
                        </label>
                    </label>
                </li>
                <li>
                    <label className="list-item">
                        <span>{lang.preferences.lineWaveformAutoAdvance}</span>
                        <label className="toggle-switch">
                            <input
                                type="checkbox"
                                checked={prefState.lineWaveformAutoAdvance}
                                onChange={onLineWaveformAutoAdvanceToggle}
                                aria-label={lang.preferences.lineWaveformAutoAdvance}
                            />
                            <span className="toggle-switch-label" />
                        </label>
                    </label>
                </li>
                <li>
                    <label className="list-item">
                        <span>{lang.preferences.lineWaveformPlayAfterSet}</span>
                        <label className="toggle-switch">
                            <input
                                type="checkbox"
                                checked={prefState.lineWaveformPlayAfterSet}
                                onChange={onLineWaveformPlayAfterSetToggle}
                                aria-label={lang.preferences.lineWaveformPlayAfterSet}
                            />
                            <span className="toggle-switch-label" />
                        </label>
                    </label>
                </li>
                <li className="preferences-section-title">
                    <h2>{lang.preferences.sections.advanced}</h2>
                </li>
                <li>
                    <label className="list-item">
                        <span>{lang.advancedLyrics.setting}</span>
                        <label className="toggle-switch">
                            <input
                                type="checkbox"
                                checked={prefState.advancedLyricsEnabled}
                                onChange={onAdvancedLyricsToggle}
                                aria-label={lang.advancedLyrics.setting}
                            />
                            <span className="toggle-switch-label" />
                        </label>
                    </label>
                </li>
                <li>
                    <label className="list-item">
                        <span>{lang.preferences.aiAlignment}</span>
                        <label className="toggle-switch">
                            <input
                                type="checkbox"
                                checked={prefState.aiAlignmentEnabled}
                                onChange={onAiAlignmentToggle}
                                aria-label={lang.preferences.aiAlignment}
                            />
                            <span className="toggle-switch-label" />
                        </label>
                    </label>
                </li>
                <li>
                    <label className="list-item">
                        <span>{lang.preferences.aiGpuAcceleration}</span>
                        <label className="toggle-switch">
                            <input
                                type="checkbox"
                                checked={prefState.aiGpuAcceleration}
                                onChange={onAiGpuAccelerationToggle}
                                aria-label={lang.preferences.aiGpuAcceleration}
                            />
                            <span className="toggle-switch-label" />
                        </label>
                    </label>
                </li>
                <li>
                    <label className="list-item">
                        <span>{lang.preferences.keepAiTaskCache}</span>
                        <label className="toggle-switch">
                            <input
                                type="checkbox"
                                checked={prefState.keepAiTaskCache}
                                onChange={onKeepAiTaskCacheToggle}
                                aria-label={lang.preferences.keepAiTaskCache}
                            />
                            <span className="toggle-switch-label" />
                        </label>
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
                <li className="huhu-settings-row">
                    <section className="list-item huhu-settings">
                        <header>
                            <strong>{lang.preferences.huhuTitle}</strong>
                            <span>{lang.preferences.huhuKeyDescription}</span>
                        </header>
                        <form onSubmit={onHuhuKeySave}>
                            <input
                                ref={huhuKeyInput}
                                type="password"
                                name="huhu-api-key-new"
                                required={true}
                                maxLength={2048}
                                autoComplete="new-password"
                                autoCapitalize="none"
                                autoCorrect="off"
                                spellCheck={false}
                                placeholder={lang.preferences.huhuKeyPlaceholder}
                                aria-label={lang.preferences.huhuApiKey}
                                disabled={huhuKeyBusy || !huhuOriginAvailable}
                            />
                            <button
                                type="submit"
                                className="button"
                                disabled={huhuKeyBusy || !huhuOriginAvailable}
                            >
                                {huhuKeyStored
                                    ? lang.preferences.huhuReplaceKey
                                    : lang.preferences.huhuSaveKey}
                            </button>
                        </form>
                        <div className="huhu-settings-actions">
                            <button
                                type="button"
                                disabled={huhuKeyBusy || !huhuKeyStored || !huhuOriginAvailable}
                                onClick={() => void onHuhuCapabilityCheck()}
                            >
                                {lang.preferences.huhuCheckCapability}
                            </button>
                            <button
                                type="button"
                                disabled={huhuKeyBusy || !huhuKeyStored}
                                onClick={() => void onHuhuKeyClear()}
                            >
                                {lang.preferences.huhuClearKey}
                            </button>
                            <label>
                                <span>{lang.preferences.huhuLanguage}</span>
                                <select
                                    value={prefState.huhuAlignmentLanguage}
                                    onChange={onHuhuLanguageChange}
                                    aria-label={lang.preferences.huhuLanguage}
                                >
                                    <option value="auto">{lang.preferences.huhuLanguageAuto}</option>
                                    <option value="ja">{lang.preferences.huhuLanguageJa}</option>
                                    <option value="en">{lang.preferences.huhuLanguageEn}</option>
                                    <option value="ja-en">{lang.preferences.huhuLanguageJaEn}</option>
                                    <option value="zh-hans-cn">{lang.preferences.huhuLanguageZh}</option>
                                    <option value="zh-hans-cn-en">{lang.preferences.huhuLanguageZhEn}</option>
                                </select>
                            </label>
                        </div>
                        <p className={`huhu-key-status status-${huhuStatus?.kind || "idle"}`} aria-live="polite">
                            {huhuKeyBusy ? lang.preferences.huhuWorking : huhuStatusText}
                        </p>
                    </section>
                </li>
                <li className="preferences-section-title">
                    <h2>{lang.preferences.sections.appearance}</h2>
                </li>
                <li>
                    <section className="list-item">
                        <span>{lang.preferences.themeMode.label}</span>
                        <div className="option-select">
                            <select
                                name="theme-mode"
                                value={prefState.themeMode}
                                onChange={onThemeModeChange}
                                aria-label={lang.preferences.themeMode.label}
                            >
                                <option value={ThemeMode.auto}>{lang.preferences.themeMode.auto}</option>
                                <option value={ThemeMode.light}>{lang.preferences.themeMode.light}</option>
                                <option value={ThemeMode.dark}>{lang.preferences.themeMode.dark}</option>
                            </select>
                        </div>
                    </section>
                </li>

                <li>
                    <section className="list-item">
                        <span>{lang.preferences.themeColor}</span>
                        <details className="dropdown">
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
                                    htmlFor="user-color-input-text"
                                    style={currentThemeColorStyle}
                                    ref={userColorLabel}
                                >
                                    {"#"}
                                    <input
                                        type="color"
                                        className="color-picker pseudo-hidden"
                                        value={prefState.themeColor}
                                        onChange={onColorPick}
                                        ref={userColorInput}
                                    />
                                </label>
                                <input
                                    ref={userColorInputText}
                                    id="user-color-input-text"
                                    name="user-color-input-text"
                                    className="user-color-input-text"
                                    type="text"
                                    pattern="[\da-f]{3,6}"
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
                            <time className="format-example-time">{convertTimeToTag(83.456, prefState.fixed)}</time>
                            <span className="format-example-text">{formattedText}</span>
                        </span>
                    </section>
                </li>
                <li>
                    <section className="list-item">
                        <span>{lang.preferences.fixed}</span>
                        <div className="option-select">
                            <select
                                name="fixed"
                                value={prefState.fixed}
                                onChange={onFixedChanged}
                                aria-label={lang.preferences.lrcFormat}
                            >
                                <option value={0}>0</option>
                                <option value={1}>1</option>
                                <option value={2}>2</option>
                                <option value={3}>3</option>
                            </select>
                        </div>
                    </section>
                </li>
                <li>
                    <label className="list-item">
                        <label htmlFor="space-start">{lang.preferences.leftSpace}</label>
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
                    <label className="list-item">
                        <label htmlFor="space-end">{lang.preferences.rightSpace}</label>
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
                    <label className="list-item">
                        <label htmlFor="seek-step-ms">{lang.preferences.seekStepMs}</label>
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
                    <label className="list-item">
                        <label htmlFor="fine-tune-ms">{lang.preferences.fineTuneMs}</label>
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
            <dialog className="about-dialog service-stop-dialog" ref={aiCacheDialog}>
                <article>
                    <h2>{lang.preferences.aiClearCacheTitle}</h2>
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
            <dialog className="about-dialog service-stop-dialog" ref={serviceStopDialog}>
                <article>
                    <h2>{lang.preferences.aiStopServiceTitle}</h2>
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
