import { type Fixed, formatText, type IFormatOptions, type State as LrcState } from "@lrc-maker/lrc-parser";

export const formatTimeTag = (time: number | undefined, fixed: Fixed, withBrackets = true): string => {
    if (time === undefined || !Number.isFinite(time)) {
        return "";
    }
    const scale = 10 ** fixed;
    const totalUnits = Math.max(0, Math.round(time * scale));
    const unitsPerMinute = 60 * scale;
    const minutes = Math.floor(totalUnits / unitsPerMinute);
    const secondUnits = totalUnits % unitsPerMinute;
    const wholeSeconds = Math.floor(secondUnits / scale);
    const fraction = fixed === 0 ? "" : `.${(secondUnits % scale).toString().padStart(fixed, "0")}`;
    const formatted = `${minutes.toString().padStart(2, "0")}:${wholeSeconds.toString().padStart(2, "0")}${fraction}`;
    return withBrackets ? `[${formatted}]` : formatted;
};

export const stringifyLrc = (state: LrcState, option: IFormatOptions): string => {
    const { spaceStart, spaceEnd, fixed, endOfLine = "\r\n" } = option;
    const infos = Array.from(state.info.entries()).map(([name, value]) => `[${name}: ${value}]`);
    const lines = state.lyric.map((line) => {
        if (line.time === undefined || !Number.isFinite(line.time)) {
            return line.text;
        }
        const text = formatText(line.text, spaceStart, spaceEnd);
        return `${formatTimeTag(line.time, fixed, true)}${text}`;
    });
    return infos.concat(lines).join(endOfLine);
};
