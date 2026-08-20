import BRAND from "#const/brand.json" assert { type: "json" };
import { useCallback, useEffect, useRef, useState } from "react";
import * as ReactDOM from "react-dom";
import { AudioActionType, audioStatePubSub } from "../utils/audiomodule.js";
import { CloseSVG, LoadAudioSVG, OpenFileSVG } from "./svg.js";

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
    currentMediaLabel: string;
    onLoadFile: (file: File) => void;
    onLoadUrl: (url: string) => Promise<void>;
    lang: Language;
}

export const LoadAudio: React.FC<ILoadAudioOptions> = ({
    accept,
    rememberedUrl,
    currentMediaLabel,
    onLoadFile,
    onLoadUrl,
    lang,
}) => {
    const self = useRef(Symbol(LoadAudio.name));
    const [busy, setBusy] = useState(false);
    const [url, setUrl] = useState(rememberedUrl);
    const [dragging, setDragging] = useState(false);
    const [fileError, setFileError] = useState(false);
    const dragDepth = useRef(0);

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

    const loadFile = useCallback((file: File) => {
        if (!isSupportedMediaFile(file)) {
            setFileError(true);
            return;
        }
        setFileError(false);
        onLoadFile(file);
    }, [onLoadFile]);

    const onDragEnter = useCallback((event: React.DragEvent<HTMLLabelElement>) => {
        event.preventDefault();
        event.stopPropagation();
        dragDepth.current += 1;
        setDragging(true);
    }, []);

    const onDragLeave = useCallback((event: React.DragEvent<HTMLLabelElement>) => {
        event.preventDefault();
        event.stopPropagation();
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
    }, []);

    const onDrop = useCallback((event: React.DragEvent<HTMLLabelElement>) => {
        event.preventDefault();
        event.stopPropagation();
        dragDepth.current = 0;
        setDragging(false);
        const file = event.dataTransfer.files[0];
        if (file) loadFile(file);
    }, [loadFile]);

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
                {currentMediaLabel && (
                    <section className="current-media-card" aria-label={lang.loadAudio.currentMedia}>
                        <LoadAudioSVG />
                        <span>{lang.loadAudio.currentMedia}</span>
                        <strong title={currentMediaLabel}>{currentMediaLabel}</strong>
                    </section>
                )}
                <label
                    className={`media-drop-zone${dragging ? " dragging" : ""}`}
                    htmlFor="audio-input"
                    onDragEnter={onDragEnter}
                    onDragLeave={onDragLeave}
                    onDragOver={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                    }}
                    onDrop={onDrop}
                >
                    <input
                        className="media-file-input"
                        id="audio-input"
                        type="file"
                        accept={accept}
                        onChange={(event) => {
                            const file = event.currentTarget.files?.[0];
                            if (file) loadFile(file);
                            event.currentTarget.value = "";
                        }}
                    />
                    <span className="media-drop-icon">
                        <OpenFileSVG />
                    </span>
                    <strong>{lang.loadAudio.fileTitle}</strong>
                    <span className="media-drop-hint">{lang.loadAudio.fileHint}</span>
                    <span className="media-format-list">MP3 · WAV · M4A · AAC · FLAC · ALAC · MP4</span>
                    {fileError && (
                        <span className="media-file-error" role="alert">{lang.loadAudio.unsupportedFile}</span>
                    )}
                </label>
                <div className="media-source-divider">
                    <span>{lang.loadAudio.orUseLink}</span>
                </div>
                <form className="audio-input-form" onSubmit={onSubmit}>
                    <header>
                        <label htmlFor="media-url">{lang.loadAudio.linkTitle}</label>
                        <span>{lang.loadAudio.linkHint}</span>
                    </header>
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
                            {busy && <i className="media-load-spinner" aria-hidden="true" />}
                            <span>{busy ? lang.loadAudio.resolving : lang.audio.loadAudio}</span>
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

const isSupportedMediaFile = (file: File): boolean =>
    file.type.startsWith("audio/")
    || file.type.startsWith("video/")
    || /\.(?:aac|aif|aiff|alac|caf|flac|m4a|mp3|mp4|ncm|oga|ogg|opus|qmcflac|qmcogg|qmc[0-3]|wav|webm)$/iu
        .test(file.name);
