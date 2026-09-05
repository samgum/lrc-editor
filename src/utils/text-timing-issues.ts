import { parser } from "@lrc-maker/lrc-parser";
import { type TimingIssue, timingIssueAt } from "./timing-issues.js";

export interface TextTimingRow {
    text: string;
    start: number;
    end: number;
    issue: TimingIssue | null;
}

export const textTimingRows = (text: string): TextTimingRow[] => {
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
        if (!match[2]) break;
    }
    entries.forEach((entry, index) => {
        rows[entry.row].issue = timingIssueAt(entries, index);
    });
    return rows;
};
