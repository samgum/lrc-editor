import ROUTER from "#const/router.json" assert { type: "json" };
import { useContext } from "react";
import { prependHash } from "../utils/router.js";
import { appContext } from "./app.context.js";
import { loadAudioDialogRef } from "./loadaudio.js";
import { EditorSVG, LoadAudioSVG, SynchronizerSVG, UtilitySVG, WordSynchronizerSVG } from "./svg.js";

export const Home: React.FC<{
    songTitle?: string;
    songArtist?: string;
    lineCount?: number;
    timedCount?: number;
    wordTimed?: boolean;
}> = ({ songTitle = "", songArtist = "", lineCount = 0, timedCount = 0, wordTimed = false }) => {
    const { lang, prefState } = useContext(appContext);
    const onLoadAudioDialogOpen = (): void => {
        loadAudioDialogRef.open();
    };

    const hasSession = lineCount > 0 || Boolean(songTitle.trim()) || Boolean(songArtist.trim());
    const progressPercent = lineCount > 0 ? Math.min(100, Math.round((timedCount / lineCount) * 100)) : 0;
    const trackLabel = [songTitle.trim(), songArtist.trim()].filter(Boolean).join(" — ")
        || lang.workspace.untitledTrack;
    const syncHref = wordTimed && prefState.advancedLyricsEnabled
        ? prependHash(ROUTER.wordSynchronizer)
        : prependHash(ROUTER.synchronizer);

    return (
        <div className="home-workspace">
            <section className="home-intro">
                <h1>{lang.workspace.title}</h1>
                <p className="home-subtitle">{lang.workspace.subtitle}</p>
            </section>

            {hasSession && (
                <section className="home-session-card" aria-label={lang.workspace.currentSession}>
                    <div className="home-session-info">
                        <span className="home-session-eyebrow">{lang.workspace.currentSession}</span>
                        <div className="home-session-title-row">
                            <strong title={trackLabel}>{trackLabel}</strong>
                            {wordTimed && (
                                <span className="home-session-badge">
                                    <WordSynchronizerSVG />
                                    {lang.advancedLyrics.wordMode}
                                </span>
                            )}
                        </div>
                        <div className="home-session-progress-row">
                            <span>
                                {lang.workspace.sessionProgress
                                    .replace("%timed", String(timedCount))
                                    .replace("%total", String(lineCount))}
                            </span>
                            <div className="home-session-meter" aria-hidden="true">
                                <span style={{ width: `${progressPercent}%` }} />
                            </div>
                        </div>
                    </div>
                    <div className="home-session-actions">
                        <a className="button home-session-secondary" href={prependHash(ROUTER.editor)}>
                            <EditorSVG />
                            <span>{lang.workspace.continueEditing}</span>
                        </a>
                        {lineCount > 0 && (
                            <a className="button home-session-primary" href={syncHref}>
                                <SynchronizerSVG />
                                <span>{lang.workspace.continueTiming}</span>
                            </a>
                        )}
                    </div>
                </section>
            )}

            <section className="home-actions" aria-label={lang.workspace.title}>
                <a href={prependHash(ROUTER.editor)}>
                    <span className="home-action-icon">
                        <EditorSVG />
                    </span>
                    <span className="home-action-copy">
                        <strong>{lang.workspace.openEditor}</strong>
                        <small>{lang.workspace.editorHint}</small>
                    </span>
                </a>
                <button type="button" onClick={onLoadAudioDialogOpen}>
                    <span className="home-action-icon">
                        <LoadAudioSVG />
                    </span>
                    <span className="home-action-copy">
                        <strong>{lang.workspace.loadMedia}</strong>
                        <small>{lang.workspace.mediaHint}</small>
                    </span>
                </button>
                <a href={prependHash(ROUTER.synchronizer)}>
                    <span className="home-action-icon">
                        <SynchronizerSVG />
                    </span>
                    <span className="home-action-copy">
                        <strong>{lang.workspace.openSynchronizer}</strong>
                        <small>{lang.workspace.syncHint}</small>
                    </span>
                </a>
                <a href={prependHash(ROUTER.tools)}>
                    <span className="home-action-icon">
                        <UtilitySVG />
                    </span>
                    <span className="home-action-copy">
                        <strong>{lang.workspace.openTools}</strong>
                        <small>{lang.workspace.toolsHint}</small>
                    </span>
                </a>
            </section>

            <p className="home-drop-tip">{lang.workspace.dropAnywhereHint}</p>
        </div>
    );
};
