import STRINGS from "#const/strings.json" assert { type: "json" };
import { convertTimeToTag, formatText } from "@lrc-maker/lrc-parser";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useDismissibleDetails } from "../hooks/useDismissibleDetails.js";
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
import { consumePreferenceFocus } from "../utils/workspace-navigation.js";
import { AboutDialog } from "./about.js";
import { appContext, ChangBits } from "./app.context.js";
import { StyledSelect } from "./styled-select.js";
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
    const colorPopover = useRef<HTMLDetailsElement>(null);
    useDismissibleDetails(colorPopover);
    const aiCacheDialog = useRef<HTMLDialogElement>(null);
    const [serviceStopping, setServiceStopping] = useState(false);
    const [aiCacheClearing, setAiCacheClearing] = useState(false);
    const [huhuKeyStored, setHuhuKeyStored] = useState<boolean | null>(null);
    const [huhuKeyBusy, setHuhuKeyBusy] = useState(false);
    const [huhuStatus, setHuhuStatus] = useState<HuhuSettingsStatus | null>(null);
    const huhuKeyInput = useRef<HTMLInputElement>(null);
    const huhuSection = useRef<HTMLElement>(null);
    const huhuOriginAvailable = import.meta.env.DEV || isHuhuBrowserOriginAllowed(location.origin);

    useEffect(() => {
        if (consumePreferenceFocus() !== "huhu") return;
        huhuSection.current?.scrollIntoView({ block: "center", behavior: "instant" });
        huhuKeyInput.current?.focus({ preventScroll: true });
    }, []);

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

    const onHuhuLanguageChange = useCallback((value: string) => {
        prefDispatch({
            type: "huhuAlignmentLanguage",
            payload: value as HuhuLanguageSelection,
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
                    <section className="list-item huhu-settings" ref={huhuSection}>
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
                            <div className="huhu-language-field">
                                <span>{lang.preferences.huhuLanguage}</span>
                                <StyledSelect
                                    value={prefState.huhuAlignmentLanguage}
                                    onValueChange={onHuhuLanguageChange}
                                    label={lang.preferences.huhuLanguage}
                                    options={[
                                        { value: "auto", label: lang.preferences.huhuLanguageAuto },
                                        { value: "ja", label: lang.preferences.huhuLanguageJa },
                                        { value: "en", label: lang.preferences.huhuLanguageEn },
                                        { value: "ja-en", label: lang.preferences.huhuLanguageJaEn },
                                        { value: "zh-hans-cn", label: lang.preferences.huhuLanguageZh },
                                        { value: "zh-hans-cn-en", label: lang.preferences.huhuLanguageZhEn },
                                        { value: "ko", label: lang.preferences.huhuLanguageKo },
                                        { value: "ko-en", label: lang.preferences.huhuLanguageKoEn },
                                    ]}
                                />
                            </div>
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
                                    htmlFor="user-color-input-text"
                                    style={currentThemeColorStyle}
                                    ref={userColorLabel}
                                >
                                    {"#"}
                                    <input
                                        type="color"
                                        className="native-color-input"
                                        aria-label={lang.visual.customColor}
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
                            <time className="format-example-time">{convertTimeToTag(83.456, prefState.fixed)}</time>
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
