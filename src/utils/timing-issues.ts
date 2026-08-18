import type { ILyric } from "@lrc-maker/lrc-parser";

export type TimingIssue = "invalidTimestamp" | "duplicateTimestamp" | "timestampBackwards";

export const timingIssueAt = (lines: readonly Pick<ILyric, "time">[], index: number): TimingIssue | null => {
    const time = lines[index]?.time;
    if (time === undefined) return null;
    if (!Number.isFinite(time) || time < 0) return "invalidTimestamp";

    const previousTime = lines[index - 1]?.time;
    const nextTime = lines[index + 1]?.time;
    if (time === previousTime || time === nextTime) return "duplicateTimestamp";
    if (previousTime !== undefined && time < previousTime) return "timestampBackwards";
    return null;
};
