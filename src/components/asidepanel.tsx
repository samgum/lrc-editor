import STRINGS from "#const/strings.json" assert { type: "json" };
import { memo, useCallback, useContext } from "react";
import { type Action, ActionType, type IState } from "../hooks/useLrc.js";
import { type State as PrefState } from "../hooks/usePref.js";
import { lrcFileName } from "../utils/lrc-file-name.js";
import { stringifyLrc } from "../utils/lrc-format.js";
import { langContext } from "./app.context.js";
import { ArrowLeftSVG, ArrowRightSVG, DownloadSVG, LockSVG } from "./svg.js";
import { SyncMode } from "./synchronizer.js";

export const AsidePanel: React.FC<{
    syncMode: SyncMode;
    setSyncMode: React.Dispatch<React.SetStateAction<SyncMode>>;
    lrcState: Pick<IState, "info" | "lyric">;
    lrcDispatch: React.Dispatch<Action>;
    prefState: PrefState;
}> = memo(({ syncMode, setSyncMode, lrcState, lrcDispatch, prefState }) => {
    const lang = useContext(langContext);

    const onSyncModeToggle = useCallback(() => {
        setSyncMode((current) => (current === SyncMode.select ? SyncMode.highlight : SyncMode.select));
    }, [setSyncMode]);

    const onDownloadClick = useCallback(() => {
        const text = stringifyLrc(lrcState, prefState);
        const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=UTF-8" }));
        const link = document.createElement("a");
        link.href = url;
        link.download = lrcFileName(lrcState.info);
        link.hidden = true;
        document.body.append(link);
        link.click();
        setTimeout(() => {
            link.remove();
            URL.revokeObjectURL(url);
        }, 1000);
    }, [lrcState, prefState]);

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
                type="button"
                onClick={onSyncModeToggle}
                title={syncMode === SyncMode.select ? lang.timing.followSelection : lang.timing.followPlayback}
                aria-label={syncMode === SyncMode.select ? lang.timing.followSelection : lang.timing.followPlayback}
                aria-pressed={syncMode === SyncMode.highlight}
                data-follow={syncMode === SyncMode.highlight ? "playback" : "selection"}
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
            <button
                type="button"
                className="aside-button ripple glow"
                title={lang.editor.downloadText}
                aria-label={lang.editor.downloadText}
                onClick={onDownloadClick}
            >
                <DownloadSVG />
            </button>
        </aside>
    );
}, (prev, next) =>
    prev.syncMode === next.syncMode
    && prev.setSyncMode === next.setSyncMode
    && prev.lrcDispatch === next.lrcDispatch
    && prev.prefState === next.prefState
    && prev.lrcState.info === next.lrcState.info
    && prev.lrcState.lyric === next.lrcState.lyric);

AsidePanel.displayName = "AsidePanel";
