import { useEffect, useRef, useState } from "react";
import { useDismissibleDetails } from "../hooks/useDismissibleDetails.js";
import { audioRef } from "../utils/audiomodule.js";
import { addTempoTap, type BeatGrid, defaultBeatGrid, tappedBpm } from "../utils/beat-grid.js";

export const BeatGridControls: React.FC<{
    grid: BeatGrid;
    selectedStart?: number;
    language: Language["advancedLyrics"];
    onChange: (next: BeatGrid) => void;
}> = ({ grid, selectedStart, language, onChange }) => {
    const taps = useRef<number[]>([]);
    const tapPlaying = useRef(false);
    const settings = useRef<HTMLDetailsElement>(null);
    useDismissibleDetails(settings);
    const [tapCount, setTapCount] = useState(0);
    const update = (patch: Partial<BeatGrid>): void => onChange({ ...grid, ...patch });
    const tap = (): void => {
        const playing = !audioRef.paused;
        if (tapPlaying.current !== playing) taps.current = [];
        tapPlaying.current = playing;
        taps.current = addTempoTap(taps.current, playing ? audioRef.currentTime * 1000 : performance.now());
        setTapCount(taps.current.length);
        const bpm = tappedBpm(taps.current);
        if (bpm !== undefined) update({ bpm });
    };

    return (
        <div
            className="word-beat-grid-tools"
            onKeyDown={(event) => {
                if (event.key === " " || event.key === "Enter") event.stopPropagation();
            }}
            onKeyUp={(event) => {
                if (event.key === " " || event.key === "Enter") event.stopPropagation();
            }}
        >
            <div className="word-beat-grid-toggles" role="group" aria-label={language.beatGrid}>
                <button type="button" aria-pressed={grid.enabled} onClick={() => update({ enabled: !grid.enabled })}>
                    {language.beatGrid}
                </button>
                <button
                    type="button"
                    aria-pressed={grid.enabled && grid.snap}
                    disabled={!grid.enabled}
                    onClick={() => update({ snap: !grid.snap })}
                >
                    {language.beatSnap}
                </button>
                {grid.enabled && grid.snap && <span className="word-beat-bypass">{language.beatBypass}</span>}
            </div>
            {grid.enabled && (
                <details
                    className="word-beat-settings"
                    ref={settings}
                    onKeyDown={(event) => {
                        if (event.key !== "Escape") return;
                        event.preventDefault();
                        event.stopPropagation();
                        event.currentTarget.open = false;
                        event.currentTarget.querySelector("summary")?.focus();
                    }}
                >
                    <summary>
                        {language.beatSettings}
                        <span>{grid.bpm} BPM</span>
                    </summary>
                    <div className="word-beat-grid-controls">
                        <GridNumberInput
                            label="BPM"
                            value={grid.bpm}
                            min={20}
                            max={400}
                            step={0.01}
                            onChange={(bpm) => update({ bpm })}
                        />
                        <button type="button" onClick={tap}>
                            {language.beatTap}
                            {tapCount > 0 ? ` · ${tapCount}` : ""}
                        </button>
                        <label>
                            <span>{language.beatSubdivision}</span>
                            <select
                                value={grid.subdivision}
                                onChange={(event) =>
                                    update({
                                        subdivision: Number(event.currentTarget.value) as BeatGrid["subdivision"],
                                    })}
                            >
                                <option value={1}>{language.beatWhole}</option>
                                <option value={2}>{language.beatHalf}</option>
                                <option value={4}>{language.beatQuarter}</option>
                                <option value={8}>{language.beatEighth}</option>
                            </select>
                        </label>
                        <GridNumberInput
                            label={language.beatMeter}
                            value={grid.beatsPerBar}
                            min={1}
                            max={16}
                            step={1}
                            onChange={(beatsPerBar) => update({ beatsPerBar })}
                        />
                        <GridNumberInput
                            label={language.beatOffset}
                            value={Math.round(grid.offset * 1000)}
                            min={-86_400_000}
                            max={86_400_000}
                            step={1}
                            onChange={(offset) => update({ offset: offset / 1000 })}
                        />
                        <button
                            type="button"
                            disabled={selectedStart === undefined}
                            onClick={() => update({ offset: selectedStart! / 1000 })}
                        >
                            {language.beatAlignSelection}
                        </button>
                        <button
                            type="button"
                            onClick={() => update({ offset: Math.round(audioRef.currentTime * 1000) / 1000 })}
                        >
                            {language.beatAlignPlayback}
                        </button>
                        <button
                            type="button"
                            onClick={() => {
                                taps.current = [];
                                setTapCount(0);
                                onChange(defaultBeatGrid());
                            }}
                        >
                            {language.beatReset}
                        </button>
                    </div>
                </details>
            )}
        </div>
    );
};

const GridNumberInput: React.FC<{
    label: string;
    value: number;
    min: number;
    max: number;
    step: number;
    onChange: (value: number) => void;
}> = ({ label, value, min, max, step, onChange }) => {
    const [draft, setDraft] = useState(String(value));
    useEffect(() => setDraft(String(value)), [value]);
    return (
        <label>
            <span>{label}</span>
            <input
                type="number"
                inputMode="decimal"
                value={draft}
                min={min}
                max={max}
                step={step}
                onChange={(event) => setDraft(event.currentTarget.value)}
                onBlur={(event) => {
                    const number = event.currentTarget.valueAsNumber;
                    const next = Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : value;
                    setDraft(String(next));
                    onChange(next);
                }}
                onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                    if (event.key === "Escape" && draft !== String(value)) {
                        event.preventDefault();
                        event.stopPropagation();
                        setDraft(String(value));
                    }
                }}
            />
        </label>
    );
};
