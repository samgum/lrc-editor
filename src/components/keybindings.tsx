import { useCallback, useContext, useEffect, useMemo, useState } from "react";
import { defaultKeyBindings } from "../utils/default-keybindings.js";
import { InputAction, inputActions } from "../utils/input-action.js";
import {
    cloneKeyBindings,
    findKeyBindingConflicts,
    formatKeyBinding,
    type KeyBinding,
    type KeyBindings,
} from "../utils/keybindings.js";
import { appContext } from "./app.context.js";
import { toastPubSub } from "./toast.js";

const actionLabelKey: Record<InputAction, keyof Language["keybindings"]["actions"]> = {
    [InputAction.Sync]: "sync",
    [InputAction.DeleteTime]: "deleteTime",
    [InputAction.ResetOffset]: "resetOffset",
    [InputAction.DecreaseOffset]: "decreaseOffset",
    [InputAction.IncreaseOffset]: "increaseOffset",
    [InputAction.PrevLine]: "prevLine",
    [InputAction.NextLine]: "nextLine",
    [InputAction.FirstLine]: "firstLine",
    [InputAction.LastLine]: "lastLine",
    [InputAction.PageUp]: "pageUp",
    [InputAction.PageDown]: "pageDown",
    [InputAction.SeekBackward]: "seekBackward",
    [InputAction.SeekForward]: "seekForward",
    [InputAction.ResetRate]: "resetRate",
    [InputAction.IncreaseRate]: "increaseRate",
    [InputAction.DecreaseRate]: "decreaseRate",
    [InputAction.TogglePlay]: "togglePlay",
    [InputAction.ShowHelp]: "showHelp",
};

const modifierCodes = new Set([
    "AltLeft",
    "AltRight",
    "ControlLeft",
    "ControlRight",
    "MetaLeft",
    "MetaRight",
    "ShiftLeft",
    "ShiftRight",
]);

export const KeyBindingsPage: React.FC = () => {
    const { lang, prefDispatch, prefState } = useContext(appContext);
    const [draft, setDraft] = useState<KeyBindings>(() => cloneKeyBindings(prefState.keyBindings));
    const [recording, setRecording] = useState<InputAction | null>(null);

    useEffect(() => {
        setDraft(cloneKeyBindings(prefState.keyBindings));
    }, [prefState.keyBindings]);

    useEffect(() => {
        if (recording === null) {
            return;
        }

        const onKeyDown = (ev: KeyboardEvent): void => {
            ev.preventDefault();
            ev.stopImmediatePropagation();

            if (ev.code === "Escape") {
                setRecording(null);
                return;
            }
            if (modifierCodes.has(ev.code)) {
                return;
            }

            const binding: KeyBinding = {
                code: ev.code || undefined,
                key: ev.code ? undefined : ev.key,
                ctrlKey: ev.ctrlKey || ev.metaKey,
                altKey: ev.altKey,
                shiftKey: ev.shiftKey,
            };

            setDraft((current) => {
                const existing = current[recording];
                const serialized = JSON.stringify(binding);
                if (existing.some((item) => JSON.stringify(item) === serialized)) {
                    return current;
                }
                return { ...current, [recording]: [...existing, binding] };
            });
            setRecording(null);
        };

        window.addEventListener("keydown", onKeyDown, true);
        return () => window.removeEventListener("keydown", onKeyDown, true);
    }, [recording]);

    const conflicts = useMemo(() => findKeyBindingConflicts(draft), [draft]);

    const removeBinding = useCallback((action: InputAction, index: number) => {
        setDraft((current) => ({
            ...current,
            [action]: current[action].filter((_, bindingIndex) => bindingIndex !== index),
        }));
    }, []);

    const restoreDefaults = useCallback(() => {
        setDraft(cloneKeyBindings(defaultKeyBindings));
        setRecording(null);
        toastPubSub.pub({ type: "info", text: lang.keybindings.resetSuccess });
    }, [lang.keybindings.resetSuccess]);

    const save = useCallback(() => {
        const nextConflicts = findKeyBindingConflicts(draft);
        if (nextConflicts.length > 0) {
            toastPubSub.pub({
                type: "warning",
                text: lang.keybindings.conflictError.replace("%d", nextConflicts.length.toString()),
            });
            return;
        }

        prefDispatch({ type: "keyBindings", payload: cloneKeyBindings(draft) });
        toastPubSub.pub({ type: "success", text: lang.keybindings.saveSuccess });
    }, [draft, lang.keybindings.conflictError, lang.keybindings.saveSuccess, prefDispatch]);

    return (
        <section className="keybindings-page">
            <header className="keybindings-heading">
                <h1>{lang.keybindings.title}</h1>
                <div className="keybindings-actions">
                    <button className="button" type="button" onClick={restoreDefaults}>
                        {lang.keybindings.resetToDefaults}
                    </button>
                    <button className="button" type="button" onClick={save} disabled={conflicts.length > 0}>
                        {lang.keybindings.save}
                    </button>
                </div>
            </header>

            {conflicts.length > 0 && (
                <p className="keybindings-conflicts" role="alert">
                    {lang.keybindings.conflictError.replace("%d", conflicts.length.toString())}
                </p>
            )}

            <ul className="keybindings-list">
                {inputActions.map((action) => (
                    <li key={action} className="keybinding-row">
                        <span className="keybinding-description">
                            {lang.keybindings.actions[actionLabelKey[action]]}
                        </span>
                        <div className="keybinding-values">
                            {draft[action].length === 0 && (
                                <span className="keybinding-empty">{lang.keybindings.noBinding}</span>
                            )}
                            {draft[action].map((binding, index) => (
                                <span className="keybinding-chip" key={`${formatKeyBinding(binding)}-${index}`}>
                                    <kbd>{formatKeyBinding(binding)}</kbd>
                                    <button
                                        type="button"
                                        aria-label={`${lang.keybindings.remove} ${formatKeyBinding(binding)}`}
                                        onClick={() =>
                                            removeBinding(action, index)}
                                    >
                                        ×
                                    </button>
                                </span>
                            ))}
                        </div>
                        <button
                            className="keybinding-record button"
                            type="button"
                            onClick={() => setRecording(recording === action ? null : action)}
                        >
                            {recording === action ? lang.keybindings.recording : lang.keybindings.record}
                        </button>
                    </li>
                ))}
            </ul>
        </section>
    );
};
