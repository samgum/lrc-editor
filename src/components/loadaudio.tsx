import BRAND from "#const/brand.json" assert { type: "json" };
import { useCallback, useEffect, useRef, useState } from "react";
import * as ReactDOM from "react-dom";
import { AudioActionType, audioStatePubSub } from "../utils/audiomodule.js";
import { CloseSVG } from "./svg.js";

interface ILoadAudioDialogRef extends React.RefObject<HTMLDialogElement> {
    readonly isOpen: boolean;
    open: () => void;
    close: () => void;
}

// let supportDialog = (window as any).HTMLDialogElement !== undefined;

export const loadAudioDialogRef: ILoadAudioDialogRef = {
    current: null,

    get isOpen() {
        return this.current !== null && this.current.open;
    },

    open() {
        if (this.current === null || this.current.open) {
            return;
        }
        this.current.showModal();
    },

    close() {
        if (this.current === null || !this.current.open) {
            return;
        }
        this.current.close();
    },
};

interface ILoadAudioOptions {
    accept: string;
    rememberedUrl: string;
    onLoadFile: (file: File) => void;
    onLoadUrl: (url: string) => Promise<void>;
    lang: Language;
}

export const LoadAudio: React.FC<ILoadAudioOptions> = ({ accept, rememberedUrl, onLoadFile, onLoadUrl, lang }) => {
    const self = useRef(Symbol(LoadAudio.name));
    const [busy, setBusy] = useState(false);
    const [url, setUrl] = useState(rememberedUrl);

    useEffect(() => setUrl(rememberedUrl), [rememberedUrl]);

    useEffect(() => {
        return audioStatePubSub.sub(self.current, (data) => {
            if (data.type === AudioActionType.getDuration) {
                loadAudioDialogRef.close();
            }
        });
    }, []);

    const onSubmit = useCallback(
        async (ev: React.FormEvent<HTMLFormElement>) => {
            ev.preventDefault();

            setBusy(true);
            try {
                await onLoadUrl(url);
            } catch {
                // The footer reports a localized error and the dialog remains open for correction.
            } finally {
                setBusy(false);
            }
        },
        [onLoadUrl, url],
    );

    const onFocus = useCallback((ev: React.FocusEvent<HTMLInputElement>) => {
        ev.target.select();
    }, []);

    return ReactDOM.createPortal(
        <dialog
            ref={loadAudioDialogRef}
            className="dialog fixed loadaudio-dialog"
            aria-labelledby="load-media-title"
            onClick={(event) => event.target === event.currentTarget && loadAudioDialogRef.close()}
        >
            <button
                className="dialog-close"
                type="button"
                aria-label={lang.about.close}
                onClick={() => loadAudioDialogRef.close()}
            >
                <CloseSVG />
            </button>
            <section className="dialog-body loadaudio-body">
                <h2 id="load-media-title">{lang.audio.loadAudio}</h2>
                <label className="media-file-action" htmlFor="audio-input">
                    <input
                        className="media-file-input"
                        id="audio-input"
                        type="file"
                        accept={accept}
                        onChange={(event) => {
                            const file = event.currentTarget.files?.[0];
                            if (file) {
                                onLoadFile(file);
                            }
                            event.currentTarget.value = "";
                        }}
                    />
                    <span>{lang.loadAudio.file}</span>
                    <strong>{lang.loadAudio.loadFile}</strong>
                </label>
                <form className="audio-input-form" onSubmit={onSubmit}>
                    <label htmlFor="media-url">{lang.loadAudio.url}</label>
                    <div>
                        <input
                            id="media-url"
                            type="text"
                            inputMode="url"
                            name="url"
                            required={true}
                            disabled={busy}
                            value={url}
                            onChange={(event) => setUrl(event.currentTarget.value)}
                            placeholder={lang.loadAudio.urlPlaceholder}
                            autoCapitalize="none"
                            autoComplete="off"
                            autoCorrect="off"
                            spellCheck={false}
                            onFocus={onFocus}
                        />
                        <button className="button" type="submit" disabled={busy}>
                            {lang.audio.loadAudio}
                        </button>
                    </div>
                </form>
                <a
                    className="media-extension-link"
                    href={BRAND.extensionRelease}
                    target="_blank"
                    rel="noopener noreferrer"
                >
                    {lang.loadAudio.installExtension}
                </a>
            </section>
        </dialog>,
        document.body,
    );
};
