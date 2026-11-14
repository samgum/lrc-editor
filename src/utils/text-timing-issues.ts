import { parser } from "@lrc-maker/lrc-parser";
import { type TimingIssue, timingIssueAt } from "./timing-issues.js";

export interface TextTimingRow {
    text: string;
    start: number;
    end: number;
    issue: TimingIssue | null;
}

export const textTimingRows = (text: string, wordTiming = false): TextTimingRow[] => {
    const rows: TextTimingRow[] = [];
    const entries: { time?: number; row: number }[] = [];
    const pattern = /([^\r\n]*)(\r\n|\n|\r|$)/g;
    for (const match of text.matchAll(pattern)) {
        if (match.index === text.length && rows.length > 0 && !/[\r\n]$/.test(text)) break;
        const value = match[1];
        const row = rows.length;
        rows.push({ text: value, start: match.index, end: match.index + value.length, issue: null });
        const parsed = parser(value).lyric[0];
        const malformed = /^\[\s*-?\d{1,3}:/.test(value) && parsed?.time === undefined;
        if (malformed) entries.push({ row, time: Number.NaN });
        else if (parsed) entries.push({ row, time: parsed.time });
        if (wordTiming) rows[row].issue = wordTagIssue(value);
        if (!match[2]) break;
    }
    entries.forEach((entry, index) => {
        rows[entry.row].issue ??= timingIssueAt(entries, index);
    });
    return rows;
};

const wordTagIssue = (text: string): TimingIssue | null => {
    let previous: number | undefined;
    let previousEnd = 0;
    for (const match of text.matchAll(/<\s*-?\d{1,3}:[^<>]*(?:>|$)/g)) {
        const tag = /^<\s*(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\s*>$/.exec(match[0]);
        if (!tag || Number(tag[2]) >= 60) return "invalidTimestamp";
        const time = Number(tag[1]) * 60000 + Number(tag[2]) * 1000 + Number((tag[3] ?? "").padEnd(3, "0"));
        if (previous !== undefined) {
            if (time === previous && text.slice(previousEnd, match.index).length > 0) return "duplicateTimestamp";
            if (time < previous) return "timestampBackwards";
        }
        previous = time;
        previousEnd = match.index! + match[0].length;
    }
    return null;
};
