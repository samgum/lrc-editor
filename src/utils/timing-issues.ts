import type { ILyric } from "@lrc-maker/lrc-parser";

export type TimingIssue = "invalidTimestamp" | "duplicateTimestamp" | "timestampBackwards";

export const timingIssueAt = (
    lines: readonly Pick<ILyric, "time">[],
    index: number,
    allowDuplicateStarts = false,
): TimingIssue | null => {
    const time = lines[index]?.time;
    if (time === undefined) return null;
    if (!Number.isFinite(time) || time < 0) return "invalidTimestamp";

    let previousTime: number | undefined;
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
        const candidate = lines[cursor]?.time;
        if (candidate !== undefined && Number.isFinite(candidate) && candidate >= 0) {
            previousTime = candidate;
            break;
        }
    }
    let nextTime: number | undefined;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        const candidate = lines[cursor]?.time;
        if (candidate !== undefined && Number.isFinite(candidate) && candidate >= 0) {
            nextTime = candidate;
            break;
        }
    }

    if (!allowDuplicateStarts && (time === previousTime || time === nextTime)) return "duplicateTimestamp";
    if (previousTime !== undefined && time < previousTime) return "timestampBackwards";
    return null;
};
