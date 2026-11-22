import { type ILyric, parser, type TrimOptios } from "@lrc-maker/lrc-parser";

const enhancedTimestamp = /<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g;
const leadingLineTimestamps = /^(?:\[\s*\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\s*\])+/g;

export class AiAlignmentResultError extends Error {
    constructor(
        readonly code:
            | "AI_ALIGNMENT_EMPTY"
            | "AI_ALIGNMENT_MISSING_TIME"
            | "AI_ALIGNMENT_DUPLICATE_TIME"
            | "AI_ALIGNMENT_TEXT_MISMATCH",
    ) {
        super(code);
        this.name = AiAlignmentResultError.name;
    }
}

export const createUntimedTranscript = (lrc: string, options: TrimOptios): string => {
    const state = parser(lrc, options);
    const lines = state.lyric.map((line) =>
        line.text.replace(leadingLineTimestamps, "").replace(enhancedTimestamp, "").trim()
    );
    while (lines[0] === "") lines.shift();
    while (lines.at(-1) === "") lines.pop();
    return lines.join("\n");
};

export const validateAlignedLyrics = (
    transcript: string,
    alignedLrc: string,
    options: TrimOptios,
): readonly ILyric[] => {
    const aligned = parser(alignedLrc.replace(/(?:\r\n|\n|\r)+$/, ""), options).lyric;
    validateLyrics(transcript, aligned);
    return aligned;
};

const validateLyrics = (transcript: string, aligned: readonly ILyric[]): void => {
    if (aligned.length === 0) throw new AiAlignmentResultError("AI_ALIGNMENT_EMPTY");

    let previous = -Infinity;
    for (const line of aligned) {
        if (line.time === undefined || !Number.isFinite(line.time) || line.time < 0) {
            throw new AiAlignmentResultError("AI_ALIGNMENT_MISSING_TIME");
        }
        if (line.time <= previous) throw new AiAlignmentResultError("AI_ALIGNMENT_DUPLICATE_TIME");
        previous = line.time;
    }

    const sourceText = transcript.split(/\r\n|\n|\r/).map((line) => line.trim()).filter(Boolean);
    const alignedText = aligned.map((line) => line.text.trim()).filter(Boolean);
    if (sourceText.length !== alignedText.length || sourceText.some((line, index) => line !== alignedText[index])) {
        throw new AiAlignmentResultError("AI_ALIGNMENT_TEXT_MISMATCH");
    }
};
