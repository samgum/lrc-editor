import { type Fixed, type ILyric, parser, type TrimOptios } from "@lrc-maker/lrc-parser";

const enhancedTimestamp = /<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g;

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
    const lines = state.lyric.map((line) => line.text.replace(enhancedTimestamp, "").trim());
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

export const validateHuhuAlignedLyrics = (
    transcript: string,
    alignedLrc: string,
    options: TrimOptios,
    precision: Fixed,
): readonly ILyric[] => {
    const aligned = parser(alignedLrc.replace(/(?:\r\n|\n|\r)+$/, ""), options).lyric;
    const sungLines = aligned.filter((line) => line.text.trim() !== "");
    validateLyrics(transcript, sungLines);

    const scale = 10 ** precision;
    const tick = (time: number): number => Math.round(Math.round(time * 1_000) / (1_000 / scale));
    validateLyrics(transcript, sungLines.map((line) => ({ ...line, time: tick(line.time!) })));

    const repaired: ILyric[] = [];
    let previousTick = -1;
    for (let index = 0; index < aligned.length;) {
        const line = aligned[index];
        if (line.text.trim() !== "") {
            repaired.push(line);
            previousTick = tick(line.time!);
            index++;
            continue;
        }

        let end = index;
        while (end < aligned.length && aligned[end].text.trim() === "") end++;
        const nextTick = end < aligned.length ? tick(aligned[end].time!) : Infinity;
        if (nextTick - previousTick - 1 < end - index) {
            throw new AiAlignmentResultError("AI_ALIGNMENT_DUPLICATE_TIME");
        }
        for (; index < end; index++) {
            const blank = aligned[index];
            const minimum = previousTick + 1;
            const maximum = nextTick - (end - index);
            const originalTick = blank.time === undefined ? NaN : tick(blank.time);
            const target = Number.isFinite(originalTick) ? originalTick : minimum;
            const adjustedTick = Math.max(minimum, Math.min(maximum, target));
            repaired.push({
                ...blank,
                time: adjustedTick === originalTick ? blank.time : adjustedTick / scale,
            });
            previousTick = adjustedTick;
        }
    }
    validateLyrics(transcript, repaired);
    return repaired;
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
