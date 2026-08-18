import { useWavesurfer } from "@wavesurfer/react";
import { useEffect, useRef } from "react";
import { audioRef } from "../utils/audiomodule";
import "./waveform.css";

interface IWaveformProps {
    source: string;
    themeColor: string;
    /**
     * @param time seconds
     */
    onSeek: (time: number) => void;
    onUnavailable: () => void;
    className?: string;
}

export const Waveform: React.FC<IWaveformProps> = ({ source, themeColor, onSeek, onUnavailable, className }) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const initialThemeColor = useRef(themeColor);
    const { wavesurfer } = useWavesurfer({
        container: containerRef,
        url: source,
        media: audioRef.current || undefined,
        waveColor: "#eeeeee",
        progressColor: initialThemeColor.current,
        cursorColor: initialThemeColor.current,
        normalize: true,
        height: 32,
        barWidth: 2,
        barGap: 1,
        barRadius: 2,
        cursorWidth: 2,
        interact: true,
        dragToSeek: true,
    });

    useEffect(() => {
        return wavesurfer?.on("interaction", (currentTime) => {
            onSeek(currentTime);
        });
    }, [wavesurfer, onSeek]);

    useEffect(() => {
        return wavesurfer?.on("error", () => onUnavailable());
    }, [onUnavailable, wavesurfer]);

    useEffect(() => {
        wavesurfer?.setOptions({ progressColor: themeColor, cursorColor: themeColor });
    }, [themeColor, wavesurfer]);

    return <div className={`waveform ${className || ""}`} ref={containerRef} aria-label="waveform"></div>;
};
