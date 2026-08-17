import ROUTER from "#const/router.json" assert { type: "json" };
import { useContext } from "react";
import { prependHash } from "../utils/router.js";
import { appContext } from "./app.context.js";
import { loadAudioDialogRef } from "./loadaudio.js";
import { EditorSVG, LoadAudioSVG, SynchronizerSVG, UtilitySVG } from "./svg.js";

export const Home: React.FC = () => {
    const { lang } = useContext(appContext);
    const onLoadAudioDialogOpen = (): void => {
        loadAudioDialogRef.open();
    };

    return (
        <div className="home-workspace">
            <section className="home-intro">
                <h1>{lang.workspace.title}</h1>
            </section>

            <section className="home-actions" aria-label={lang.workspace.title}>
                <a href={prependHash(ROUTER.editor)}>
                    <EditorSVG />
                    <span>{lang.workspace.openEditor}</span>
                </a>
                <button type="button" onClick={onLoadAudioDialogOpen}>
                    <LoadAudioSVG />
                    <span>{lang.workspace.loadMedia}</span>
                </button>
                <a href={prependHash(ROUTER.synchronizer)}>
                    <SynchronizerSVG />
                    <span>{lang.workspace.openSynchronizer}</span>
                </a>
                <a href={prependHash(ROUTER.tools)}>
                    <UtilitySVG />
                    <span>{lang.workspace.openTools}</span>
                </a>
            </section>
        </div>
    );
};
