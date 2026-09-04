import SSK from "#const/session_key.json" assert { type: "json" };
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { useKeyBindings } from "../hooks/useKeyBindings.js";
import { alignmentMediaName, clearAlignmentMediaSource, setAlignmentMediaSource } from "../utils/alignment-media.js";
import { AudioActionType, audioRef, audioStatePubSub, currentTimePubSub } from "../utils/audiomodule.js";
import { InputAction } from "../utils/input-action.js";
import { isKeyboardElement } from "../utils/is-keyboard-element.js";
import { getMatchedAction } from "../utils/keybindings.js";
import { isLocalMediaFile, needsCodecFallback, shouldCreateCompressedAlignmentMedia } from "../utils/local-media.js";
import { MediaExtensionError } from "../utils/media-extension-bridge.js";
import { mediaFileNameFromUrl } from "../utils/media-name.js";
import {
    extractMediaUrl,
    extractSharedMediaUrl,
    materializeExtensionMedia,
    parseMediaInput,
    resolveMediaInput,
} from "../utils/media-source.js";
import { droppedMediaFilePubSub } from "../utils/workspace-drop.js";
import { appContext, ChangBits } from "./app.context.js";
import { LrcAudio } from "./audio.js";
import { LoadAudio } from "./loadaudio.js";
import { toastPubSub } from "./toast.js";

const accept = [
    "audio/*",
    "video/*",
    ".aac",
    ".aif",
    ".aiff",
    ".alac",
    ".caf",
    ".flac",
    ".m4a",
    ".ncm",
    ".oga",
    ".opus",
    ".qmcflac",
    ".qmcogg",
    ".qmc0",
    ".qmc1",
    ".qmc2",
    ".qmc3",
].join(", ");

export const Footer: React.FC = () => {
    const { prefState, lang } = useContext(appContext, ChangBits.lang | ChangBits.builtInAudio | ChangBits.prefState);
    const keyBindings = useKeyBindings();
    const resumeAfterBackgroundRef = useRef(false);

    useEffect(() => {
        const onVisibilityChange = (): void => {
            if (document.hidden) {
                resumeAfterBackgroundRef.current = prefState.allowBackgroundAudio && !audioRef.paused;
                if (!prefState.allowBackgroundAudio && !audioRef.paused) audioRef.current?.pause();
                return;
            }
            if (resumeAfterBackgroundRef.current && audioRef.paused) {
                void audioRef.current?.play().catch(() => undefined);
            }
            resumeAfterBackgroundRef.current = false;
        };
        document.addEventListener("visibilitychange", onVisibilityChange);
        return () => document.removeEventListener("visibilitychange", onVisibilityChange);
    }, [prefState.allowBackgroundAudio]);

    useEffect(() => {
        const preservePlaybackAcrossRoute = (): void => {
            const shouldKeepPlaying = !audioRef.paused;
            const time = audioRef.currentTime;
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    if (!shouldKeepPlaying || !audioRef.paused || !audioRef.duration) return;
                    audioRef.currentTime = time;
                    void audioRef.current?.play().catch(() => undefined);
                });
            });
        };
        window.addEventListener("hashchange", preservePlaybackAcrossRoute);
        return () => window.removeEventListener("hashchange", preservePlaybackAcrossRoute);
    }, []);

    const [audioSrc, setAudioSrcState] = useState<string | undefined>(() =>
        sessionStorage.getItem(SSK.audioSrc) || undefined
    );
    const [rememberedMediaUrl, setRememberedMediaUrl] = useState(() =>
        sessionStorage.getItem(SSK.mediaInputDisplay) || ""
    );
    const [currentMediaLabel, setCurrentMediaLabel] = useState(() =>
        sessionStorage.getItem(SSK.mediaInputDisplay) || ""
    );
    const localFileRef = useRef<File | null>(null);
    const fallbackAttemptedRef = useRef(false);
    const restoredMediaRef = useRef<string | null>(null);
    const droppedMediaSubscriber = useRef(Symbol("dropped-media-file"));
    const setAudioSrc = useCallback((newSrc: string): void => {
        setAudioSrcState((oldSrc) => {
            if (oldSrc) {
                URL.revokeObjectURL(oldSrc);
            }
            return newSrc;
        });
    }, []);

    useEffect(() => {
        if (!("mediaSession" in navigator)) return;
        const setMediaAction = (
            action: MediaSessionAction,
            handler: MediaSessionActionHandler | null,
        ): void => {
            try {
                navigator.mediaSession.setActionHandler(action, handler);
            } catch (error) {
                console.debug(`Media Session action ${action} is unavailable`, error);
            }
        };
        const seek = (offsetSeconds: number): void => {
            audioRef.currentTime = Math.max(0, Math.min(audioRef.duration, audioRef.currentTime + offsetSeconds));
            currentTimePubSub.pub(audioRef.currentTime);
        };
        if (typeof MediaMetadata !== "undefined") {
            navigator.mediaSession.metadata = new MediaMetadata({
                title: currentMediaLabel || "LRC Editor",
                artist: location.hostname,
            });
        }
        setMediaAction("play", () => {
            void audioRef.current?.play().catch(() => undefined);
        });
        setMediaAction("pause", () => audioRef.current?.pause());
        setMediaAction("seekbackward", (details) => seek(-(details.seekOffset || 10)));
        setMediaAction("seekforward", (details) => seek(details.seekOffset || 10));
        setMediaAction("seekto", (details) => {
            if (details.seekTime === undefined) return;
            audioRef.currentTime = details.seekTime;
            currentTimePubSub.pub(audioRef.currentTime);
        });
        return () => {
            for (const action of ["play", "pause", "seekbackward", "seekforward", "seekto"] as const) {
                setMediaAction(action, null);
            }
        };
    }, [currentMediaLabel]);

    const loadMediaUrl = useCallback(
        async (value: string): Promise<void> => {
            localFileRef.current = null;
            fallbackAttemptedRef.current = false;
            clearAlignmentMediaSource();
            let provider: "bilibili" | "netease" | "qqmusic" | "youtube" | null = null;
            try {
                const parsed = parseMediaInput(value);
                if (
                    parsed.kind === "youtube" || parsed.kind === "bilibili" || parsed.kind === "netease-short"
                    || parsed.kind === "netease" || parsed.kind === "qqmusic-short" || parsed.kind === "qqmusic"
                ) {
                    provider = parsed.kind === "netease-short" || parsed.kind === "netease"
                        ? "netease"
                        : parsed.kind === "qqmusic-short" || parsed.kind === "qqmusic"
                        ? "qqmusic"
                        : parsed.kind;
                    toastPubSub.pub({
                        type: "info",
                        text: provider === "youtube"
                            ? lang.notify.youtubeResolving
                            : provider === "bilibili"
                            ? lang.notify.bilibiliResolving
                            : provider === "qqmusic"
                            ? lang.notify.qqmusicResolving
                            : lang.notify.neteaseResolving,
                    });
                }
                const source = await resolveMediaInput(value);
                const playableSrc = await materializeExtensionMedia(source);
                const displayInput = extractMediaUrl(value);
                sessionStorage.setItem(SSK.mediaInputDisplay, displayInput);
                setRememberedMediaUrl(displayInput);
                setCurrentMediaLabel(source.name || displayInput);
                if (parsed.kind !== "direct") {
                    sessionStorage.setItem(SSK.mediaInput, parsed.originalUrl);
                    restoredMediaRef.current = `input:${parsed.originalUrl}`;
                } else {
                    sessionStorage.removeItem(SSK.mediaInput);
                }
                if (source.persist) {
                    sessionStorage.setItem(SSK.audioSrc, source.src);
                    restoredMediaRef.current = `audio:${source.src}`;
                } else {
                    sessionStorage.removeItem(SSK.audioSrc);
                }
                if (playableSrc.startsWith("blob:")) {
                    const blob = await fetch(playableSrc).then((response) => response.blob());
                    setAlignmentMediaSource({
                        blob,
                        name: source.name || alignmentMediaName(source.provider, source.mimeType || blob.type),
                    });
                } else {
                    setAlignmentMediaSource({
                        name: source.name || alignmentMediaName(source.provider, source.mimeType),
                        url: playableSrc,
                    });
                }
                setAudioSrc(playableSrc);
            } catch (error) {
                const message = error instanceof MediaExtensionError && error.code === "missing"
                    ? lang.notify.mediaExtensionMissing
                    : error instanceof MediaExtensionError && error.code === "outdated"
                    ? lang.notify.mediaExtensionOutdated
                    : error instanceof MediaExtensionError
                    ? provider === "bilibili"
                        ? lang.notify.bilibiliResolveFailed
                        : provider === "netease"
                        ? lang.notify.neteaseResolveFailed
                        : provider === "qqmusic"
                        ? error.reason === "NOT_PLAYABLE"
                            ? lang.notify.qqmusicNotPlayable
                            : lang.notify.qqmusicResolveFailed
                        : lang.notify.youtubeResolveFailed
                    : lang.notify.invalidMediaUrl;
                toastPubSub.pub({ type: "warning", text: message });
                throw error;
            }
        },
        [
            lang.notify.invalidMediaUrl,
            lang.notify.bilibiliResolveFailed,
            lang.notify.bilibiliResolving,
            lang.notify.mediaExtensionMissing,
            lang.notify.mediaExtensionOutdated,
            lang.notify.neteaseResolveFailed,
            lang.notify.neteaseResolving,
            lang.notify.qqmusicNotPlayable,
            lang.notify.qqmusicResolveFailed,
            lang.notify.qqmusicResolving,
            lang.notify.youtubeResolveFailed,
            lang.notify.youtubeResolving,
        ],
    );

    useEffect(() => {
        const sharedUrl = extractSharedMediaUrl(new URL(location.href));
        if (sharedUrl !== null) {
            const key = `input:${sharedUrl}`;
            if (restoredMediaRef.current === key) return;
            restoredMediaRef.current = key;
            void loadMediaUrl(sharedUrl).catch(() => undefined);
            return;
        }
        const rememberedInput = sessionStorage.getItem(SSK.mediaInput);
        if (rememberedInput) {
            const key = `input:${rememberedInput}`;
            if (restoredMediaRef.current === key) return;
            restoredMediaRef.current = key;
            void loadMediaUrl(rememberedInput).catch(() => undefined);
            return;
        }
        const rememberedAudio = sessionStorage.getItem(SSK.audioSrc);
        if (rememberedAudio) {
            const key = `audio:${rememberedAudio}`;
            if (restoredMediaRef.current === key) return;
            restoredMediaRef.current = key;
            const name = mediaFileNameFromUrl(rememberedAudio) || alignmentMediaName("remote");
            setAlignmentMediaSource({ name, url: rememberedAudio });
            setCurrentMediaLabel(name);
        }
    }, [loadMediaUrl]);

    useEffect(() => {
        function onKeydown(ev: KeyboardEvent) {
            if (isKeyboardElement(ev.target)) {
                return;
            }

            if (!audioRef.src) {
                return;
            }

            const action = getMatchedAction(ev, keyBindings);

            switch (action) {
                case InputAction.SeekBackward:
                    ev.preventDefault();
                    audioRef.step(ev, -prefState.seekStepMs / 1000);
                    break;
                case InputAction.SeekForward:
                    ev.preventDefault();
                    audioRef.step(ev, prefState.seekStepMs / 1000);
                    break;
                case InputAction.ResetRate:
                    ev.preventDefault();
                    audioRef.playbackRate = 1;
                    break;
                case InputAction.IncreaseRate: {
                    ev.preventDefault();
                    const rate = audioRef.playbackRate;
                    audioRef.playbackRate = Math.exp(Math.min(Math.log(rate) + 0.2, 1));
                    break;
                }
                case InputAction.DecreaseRate: {
                    ev.preventDefault();
                    const rate = audioRef.playbackRate;
                    audioRef.playbackRate = Math.exp(Math.max(Math.log(rate) - 0.2, -1));
                    break;
                }
                case InputAction.TogglePlay:
                    ev.preventDefault();
                    audioRef.toggle();
                    break;
            }
        }
        document.addEventListener("keydown", onKeydown);

        return () => document.removeEventListener("keydown", onKeydown);
    }, [keyBindings, prefState.seekStepMs]);

    const onAudioFile = useCallback((file: File) => {
        sessionStorage.removeItem(SSK.audioSrc);
        sessionStorage.removeItem(SSK.mediaInput);
        sessionStorage.removeItem(SSK.mediaInputDisplay);
        setRememberedMediaUrl("");
        setCurrentMediaLabel(file.name);
        localFileRef.current = isLocalMediaFile(file) ? file : null;
        fallbackAttemptedRef.current = false;
        clearAlignmentMediaSource();

        if (localFileRef.current) {
            void (async () => {
                try {
                    const [compressForAlignment, browserFallback] = await Promise.all([
                        shouldCreateCompressedAlignmentMedia(file),
                        needsCodecFallback(file),
                    ]);
                    if (compressForAlignment || browserFallback) {
                        fallbackAttemptedRef.current = true;
                        const converted = await convertLocalFile(file, lang);
                        if (localFileRef.current !== file) return;
                        if (converted) {
                            setAlignmentMediaSource({ blob: converted, name: compressedMediaName(file.name) });
                            setAudioSrc(URL.createObjectURL(converted));
                            localFileRef.current = null;
                        } else if (compressForAlignment && !browserFallback) {
                            setAudioSrc(URL.createObjectURL(file));
                        }
                    } else {
                        setAlignmentMediaSource({ blob: file, name: file.name });
                        setAudioSrc(URL.createObjectURL(file));
                    }
                } catch {
                    toastPubSub.pub({ type: "warning", text: lang.notify.mediaConversionFailed });
                }
            })();
        } else {
            receiveEncryptedFile(file, (media, name) => {
                void (async () => {
                    const decoded = new File([media], name, { type: media.type });
                    if (await shouldCreateCompressedAlignmentMedia(decoded)) {
                        const converted = await convertLocalFile(decoded, lang);
                        if (converted) {
                            setAlignmentMediaSource({ blob: converted, name: compressedMediaName(name) });
                            setAudioSrc(URL.createObjectURL(converted));
                        } else {
                            setAudioSrc(URL.createObjectURL(media));
                        }
                        return;
                    }
                    setAlignmentMediaSource({ blob: media, name });
                    setAudioSrc(URL.createObjectURL(media));
                })().catch(() => {
                    toastPubSub.pub({ type: "warning", text: lang.notify.mediaConversionFailed });
                });
            });
        }
    }, [lang]);

    useEffect(() => droppedMediaFilePubSub.sub(droppedMediaSubscriber.current, onAudioFile), [onAudioFile]);

    const rafId = useRef(0);

    const onAudioLoadedMetadata = useCallback(() => {
        cancelAnimationFrame(rafId.current);
        audioStatePubSub.pub({
            type: AudioActionType.getDuration,
            payload: audioRef.duration,
        });
        toastPubSub.pub({
            type: "success",
            text: lang.notify.audioLoaded,
        });
    }, [lang]);

    const syncCurrentTime = useCallback(() => {
        currentTimePubSub.pub(audioRef.currentTime);
        rafId.current = requestAnimationFrame(syncCurrentTime);
    }, []);

    const onAudioPlay = useCallback(() => {
        rafId.current = requestAnimationFrame(syncCurrentTime);
        if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
        audioStatePubSub.pub({
            type: AudioActionType.pause,
            payload: false,
        });
    }, [syncCurrentTime]);

    const onAudioPause = useCallback(() => {
        cancelAnimationFrame(rafId.current);
        if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
        audioStatePubSub.pub({
            type: AudioActionType.pause,
            payload: true,
        });
    }, []);

    const onAudioEnded = useCallback(() => {
        cancelAnimationFrame(rafId.current);
        if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "none";
        audioStatePubSub.pub({
            type: AudioActionType.pause,
            payload: true,
        });
    }, []);

    const onAudioTimeUpdate = useCallback(() => {
        if (audioRef.paused) {
            currentTimePubSub.pub(audioRef.currentTime);
        }
    }, []);

    const onAudioRateChange = useCallback(() => {
        audioStatePubSub.pub({
            type: AudioActionType.rateChange,
            payload: audioRef.playbackRate,
        });
    }, []);

    const onAudioError = useCallback(
        (ev: React.SyntheticEvent<HTMLAudioElement>) => {
            const localFile = localFileRef.current;
            if (localFile && !fallbackAttemptedRef.current) {
                fallbackAttemptedRef.current = true;
                void convertLocalFile(localFile, lang).then((converted) => {
                    if (!converted || localFileRef.current !== localFile) return;
                    setAlignmentMediaSource({ blob: converted, name: compressedMediaName(localFile.name) });
                    setAudioSrc(URL.createObjectURL(converted));
                    localFileRef.current = null;
                });
                return;
            }
            const audio = ev.target as HTMLAudioElement;
            const error = audio.error!;
            const message = lang.audio.error[error.code] || error.message || lang.audio.error[0];
            toastPubSub.pub({
                type: "warning",
                text: message,
            });
        },
        [lang, setAudioSrc],
    );

    return (
        <footer className="app-footer">
            <LoadAudio
                accept={accept}
                rememberedUrl={rememberedMediaUrl}
                currentMediaLabel={currentMediaLabel}
                onLoadFile={onAudioFile}
                onLoadUrl={loadMediaUrl}
                lang={lang}
            />
            <audio
                ref={audioRef}
                src={audioSrc}
                playsInline={true}
                controls={prefState.builtInAudio}
                hidden={!prefState.builtInAudio}
                onLoadedMetadata={onAudioLoadedMetadata}
                onPlay={onAudioPlay}
                onPause={onAudioPause}
                onEnded={onAudioEnded}
                onTimeUpdate={onAudioTimeUpdate}
                onRateChange={onAudioRateChange}
                onError={onAudioError}
            />
            {prefState.builtInAudio || <LrcAudio lang={lang} />}
        </footer>
    );
};

type SetAlignmentMedia = (media: Blob, name: string) => void;

const receiveEncryptedFile = (
    file: File,
    setAlignmentMedia: SetAlignmentMedia,
): void => {
    if (file.name.toLowerCase().endsWith(".ncm")) {
        const worker = new Worker(new URL("/worker/ncmc-worker.js", import.meta.url));
        worker.addEventListener(
            "message",
            (ev: IMessageEvent<IMessage>) => {
                if (ev.data.type === "success") {
                    const dataArray = ev.data.payload;
                    const mimeType = detectMimeType(dataArray);
                    const musicFile = new Blob([dataArray as Uint8Array<ArrayBuffer>], { type: mimeType });

                    setAlignmentMedia(musicFile, decodedMediaName(file.name, mimeType));
                }
                if (ev.data.type === "error") {
                    toastPubSub.pub({
                        type: "warning",
                        text: ev.data.payload,
                    });
                }
            },
            { once: true },
        );

        worker.addEventListener(
            "error",
            (ev) => {
                toastPubSub.pub({
                    type: "warning",
                    text: ev.message,
                });
                worker.terminate();
            },
            { once: true },
        );

        worker.postMessage(file);

        return;
    }
    if (/\.qmc(?:flac|ogg|0|1|2|3)$/i.test(file.name)) {
        const worker = new Worker(new URL("/worker/qmc-worker.js", import.meta.url));
        worker.addEventListener(
            "message",
            (ev: IMessageEvent<IMessage>) => {
                if (ev.data.type === "success") {
                    const dataArray = ev.data.payload;
                    const mimeType = detectMimeType(dataArray);
                    const musicFile = new Blob([dataArray as Uint8Array<ArrayBuffer>], { type: mimeType });

                    setAlignmentMedia(musicFile, decodedMediaName(file.name, mimeType));
                }
            },
            { once: true },
        );

        worker.postMessage(file);
    }
};

const convertLocalFile = async (file: File, lang: Language): Promise<Blob | null> => {
    toastPubSub.pub({ type: "info", text: lang.notify.transcodingMedia });
    try {
        const { transcodeAudioForBrowser } = await import("../utils/audio-transcoder.js");
        const converted = await transcodeAudioForBrowser(file);
        toastPubSub.pub({ type: "success", text: lang.notify.mediaConverted });
        return converted;
    } catch (error) {
        console.error("Local audio conversion failed", error);
        toastPubSub.pub({ type: "warning", text: lang.notify.mediaConversionFailed });
        return null;
    }
};

const compressedMediaName = (name: string): string => `${name.replace(/\.[^.]*$/, "") || "audio"}.m4a`;

const decodedMediaName = (name: string, mimeType: string): string => {
    const extension = mimeType === "audio/flac"
        ? "flac"
        : mimeType === "audio/mp4"
        ? "m4a"
        : mimeType === "audio/ogg"
        ? "ogg"
        : mimeType === "audio/wav"
        ? "wav"
        : "mp3";
    return `${name.replace(/\.[^.]*$/, "") || "audio"}.${extension}`;
};

const MimeType = {
    fLaC: 0x664c6143,
    ftyp: 0x66747970,
    OggS: 0x4f676753,
    RIFF: 0x52494646,
    WAVE: 0x57415645,
};

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const detectMimeType = (dataArray: Uint8Array) => {
    const dataView = new DataView(dataArray.buffer, dataArray.byteOffset, dataArray.byteLength);
    if (dataView.byteLength >= 8 && dataView.getUint32(4, false) === MimeType.ftyp) {
        return "audio/mp4";
    }
    if (dataView.byteLength < 4) {
        return "application/octet-stream";
    }
    const magicNumber = dataView.getUint32(0, false);
    switch (magicNumber) {
        case MimeType.fLaC:
            return "audio/flac";

        case MimeType.OggS:
            return "audio/ogg";

        case MimeType.RIFF:
        case MimeType.WAVE:
            return "audio/wav";

        default:
            return "audio/mpeg";
    }
};
