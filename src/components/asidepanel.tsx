import STRINGS from "#const/strings.json" assert { type: "json" };
import { stringify } from "@lrc-maker/lrc-parser";
import { memo, useCallback, useContext, useState } from "react";
import { type Action, ActionType } from "../hooks/useLrc.js";
import { type State as PrefState } from "../hooks/usePref.js";
import { lrcFileName } from "../utils/lrc-file-name.js";
import { appContext } from "./app.context.js";
import { ArrowLeftSVG, ArrowRightSVG, DownloadSVG, LockSVG } from "./svg.js";
import { SyncMode } from "./synchronizer.js";

export const AsidePanel: React.FC<{
    syncMode: SyncMode;
    setSyncMode: React.Dispatch<React.SetStateAction<SyncMode>>;
    lrcDispatch: React.Dispatch<Action>;
    prefState: PrefState;
}> = memo(({ syncMode, setSyncMode, lrcDispatch, prefState }) => {
    const { lang } = useContext(appContext);
    const [href, setHref] = useState<string>();
    const [name, setName] = useState<string>();

    const onSyncModeToggle = useCallback(() => {
        setSyncMode((syncMode) => (syncMode === SyncMode.select ? SyncMode.highlight : SyncMode.select));
    }, [setSyncMode]);

    const onDownloadClick = useCallback(() => {
        lrcDispatch({
            type: ActionType.getState,
            payload: (state) => {
                const text = stringify(state, prefState);
                setHref((url) => {
                    if (url) {
                        URL.revokeObjectURL(url);
                    }

                    return URL.createObjectURL(
                        new Blob([text], {
                            type: "text/plain;charset=UTF-8",
                        }),
                    );
                });

                setName(lrcFileName(state.info));
            },
        });
    }, [lrcDispatch, prefState]);

    const mode = syncMode === SyncMode.select ? "select" : "highlight";

    const offsetAll = useCallback(
        (direction: -1 | 1) => {
            lrcDispatch({ type: ActionType.offsetAll, payload: direction * prefState.fineTuneMs / 1000 });
        },
        [lrcDispatch, prefState.fineTuneMs],
    );

    const className = ["aside-button", "syncmode-button", "ripple", "glow ", mode].join(STRINGS.space);

    return (
        <aside className="aside-panel">
            <button
                className={className}
                onClick={onSyncModeToggle}
                title={syncMode === SyncMode.select ? lang.timing.followSelection : lang.timing.followPlayback}
                aria-label={syncMode === SyncMode.select ? lang.timing.followSelection : lang.timing.followPlayback}
            >
                <LockSVG />
            </button>
            <button
                className="aside-button ripple glow"
                type="button"
                title={`${lang.timing.moveAllEarlier}: ${prefState.fineTuneMs} ms`}
                aria-label={`${lang.timing.moveAllEarlier}: ${prefState.fineTuneMs} ms`}
                onClick={() => offsetAll(-1)}
            >
                <ArrowLeftSVG />
            </button>
            <button
                className="aside-button ripple glow"
                type="button"
                title={`${lang.timing.moveAllLater}: ${prefState.fineTuneMs} ms`}
                aria-label={`${lang.timing.moveAllLater}: ${prefState.fineTuneMs} ms`}
                onClick={() => offsetAll(1)}
            >
                <ArrowRightSVG />
            </button>
            <a
                href={href}
                download={name}
                className="aside-button ripple glow"
                title={lang.editor.downloadText}
                aria-label={lang.editor.downloadText}
                onClick={onDownloadClick}
            >
                <DownloadSVG />
            </a>
        </aside>
    );
});

AsidePanel.displayName = AsidePanel.name;
