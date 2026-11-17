import { type TimingIssue, timingIssueAt } from "./timing-issues.js";

export interface TextTimingRow {
    text: string;
    start: number;
    end: number;
    issue: TimingIssue | null;
}

const lineTagPattern = /^\[\s*(\d{1,3}):(\d{1,2})(?:[:.](\d{1,3}))?\s*\]/;
const malformedLineTagPattern = /^\[\s*-?\d{1,3}:/;

export const textTimingRows = (text: string, wordTiming = false): TextTimingRow[] => {
    const rows: TextTimingRow[] = [];
    const entries: { time?: number; row: number }[] = [];
    const pattern = /([^\r\n]*)(\r\n|\n|\r|$)/g;
    for (const match of text.matchAll(pattern)) {
        if (match.index === text.length && rows.length > 0 && !/[\r\n]$/.test(text)) break;
        const value = match[1];
        const row = rows.length;
        rows.push({ text: value, start: match.index, end: match.index + value.length, issue: null });
        if (value.startsWith("[")) {
            const tag = lineTagPattern.exec(value);
            if (tag) {
                const seconds = Number(tag[2]);
                if (seconds >= 60) {
                    entries.push({ row, time: Number.NaN });
                } else {
                    const fraction = tag[3] ? Number(tag[3]) / 10 ** tag[3].length : 0;
                    entries.push({ row, time: Number(tag[1]) * 60 + seconds + fraction });
                }
            } else if (malformedLineTagPattern.test(value)) {
                entries.push({ row, time: Number.NaN });
            }
        }
        if (wordTiming) rows[row].issue = wordTagIssue(value);
        if (!match[2]) break;
    }
    entries.forEach((entry, index) => {
        const hasWordTags = /<\s*\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\s*>/.test(rows[entry.row].text);
        rows[entry.row].issue ??= timingIssueAt(entries, index, wordTiming && hasWordTags);
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
