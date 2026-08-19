import type { LyricsWorkspaceMode } from "../utils/advanced-lyrics.js";

export const LyricsModeSwitch: React.FC<{
    mode: LyricsWorkspaceMode;
    onChange: (mode: LyricsWorkspaceMode) => void;
    labels: Pick<Language["advancedLyrics"], "lineMode" | "wordMode">;
    className?: string;
}> = ({ mode, onChange, labels, className = "" }) => (
    <div
        className={`lyrics-mode-switch ${className}`}
        role="group"
        aria-label={`${labels.lineMode} / ${labels.wordMode}`}
    >
        <button
            type="button"
            className={mode === "line" ? "active" : ""}
            aria-pressed={mode === "line"}
            onClick={() => onChange("line")}
        >
            {labels.lineMode}
        </button>
        <button
            type="button"
            className={mode === "word" ? "active" : ""}
            aria-pressed={mode === "word"}
            onClick={() => onChange("word")}
        >
            {labels.wordMode}
        </button>
    </div>
);
