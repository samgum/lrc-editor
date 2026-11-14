import { type AdvancedLyricLine, lineText, type TimedWord, tokenizeLyricText } from "./advanced-lyrics.js";

export interface TextEditRange {
    start: number;
    end: number;
}

const matchKey = (text: string): string =>
    text.replace(/[’ʼ]/gu, "'").replace(/[A-Z]/g, (letter) => letter.toLowerCase());

const atoms = (text: string) =>
    Array.from(
        text.matchAll(
            /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]|[\p{L}\p{N}\p{M}]+(?:['’ʼ-][\p{L}\p{N}\p{M}]+)*|\s+|[^\s]/gu,
        ),
        (match) => ({
            text: match[0],
            key: matchKey(match[0]),
            start: match.index!,
            end: match.index! + match[0].length,
        }),
    );

const exactTokens = (text: string): { start: number; end: number }[] => {
    const result: { start: number; end: number }[] = [];
    let position = 0;
    for (const word of tokenizeLyricText(text)) {
        const start = position;
        for (const character of word.text.replace(/\s/gu, "")) {
            while (position < text.length && /\s/u.test(text[position])) position++;
            if (!text.startsWith(character, position)) return atoms(text).map(({ start, end }) => ({ start, end }));
            position += character.length;
        }
        while (position < text.length && /\s/u.test(text[position])) position++;
        if (position > start) result.push({ start, end: position });
    }
    return position === text.length ? result : atoms(text).map(({ start, end }) => ({ start, end }));
};

export const editWordTimedLine = (line: AdvancedLyricLine, text: string, edit?: TextEditRange): AdvancedLyricLine => {
    const before = lineText(line);
    if (text === before) return line;
    if (!text.trim()) return { ...line, words: [{ text }] };
    const oldAtoms = atoms(before);
    const newAtoms = atoms(text);
    const mapping = new Int32Array(before.length).fill(-1);
    const match = (oldIndex: number, newIndex: number): void => {
        const old = oldAtoms[oldIndex];
        const next = newAtoms[newIndex];
        for (let index = 0; index < old.text.length; index++) mapping[old.start + index] = next.start + index;
    };
    const delta = text.length - before.length;
    const validEdit = edit && edit.start >= 0 && edit.end >= edit.start && edit.end <= before.length
        && text.startsWith(before.slice(0, edit.start)) && text.endsWith(before.slice(edit.end))
        && text.length >= edit.start + before.length - edit.end
        && !(edit.start === 0 && edit.end === before.length);
    let left = 0;
    while (
        left < oldAtoms.length && left < newAtoms.length
        && oldAtoms[left].key === newAtoms[left].key
        && (!validEdit || oldAtoms[left].end <= edit.start)
    ) {
        match(left, left);
        left++;
    }
    let oldRight = oldAtoms.length;
    let newRight = newAtoms.length;
    while (
        oldRight > left && newRight > left
        && oldAtoms[oldRight - 1].key === newAtoms[newRight - 1].key
        && (!validEdit || (oldAtoms[oldRight - 1].start >= edit.end
            && newAtoms[newRight - 1].start === oldAtoms[oldRight - 1].start + delta))
    ) {
        match(--oldRight, --newRight);
    }
    const oldCount = oldRight - left;
    const newCount = newRight - left;
    // Normal edits leave a small middle. Bound memory when replacing an exceptionally long line.
    if ((oldCount + 1) * (newCount + 1) <= 1_000_000) {
        const width = newCount + 1;
        const lengths = new Uint32Array((oldCount + 1) * width);
        for (let old = oldCount - 1; old >= 0; old--) {
            for (let next = newCount - 1; next >= 0; next--) {
                lengths[old * width + next] = oldAtoms[left + old].key === newAtoms[left + next].key
                    ? 1 + lengths[(old + 1) * width + next + 1]
                    : Math.max(lengths[(old + 1) * width + next], lengths[old * width + next + 1]);
            }
        }
        let old = 0;
        let next = 0;
        while (old < oldCount && next < newCount) {
            if (oldAtoms[left + old].key === newAtoms[left + next].key) match(left + old++, left + next++);
            else if (lengths[(old + 1) * width + next] >= lengths[old * width + next + 1]) old++;
            else next++;
        }
    }
    const anchors: { start: number; end: number; source: number }[] = [];
    const emptyTimed: { position: number; source: number; word: TimedWord }[] = [];
    let sourceOffset = 0;
    line.words.forEach((word, source) => {
        if (!word.text && (word.startMs !== undefined || word.endMs !== undefined)) {
            const left = sourceOffset > 0 && mapping[sourceOffset - 1] >= 0 ? mapping[sourceOffset - 1] + 1 : -1;
            const right = sourceOffset < before.length ? mapping[sourceOffset] : -1;
            if (
                (sourceOffset === 0 && right >= 0) || (sourceOffset === before.length && left >= 0)
                || (left >= 0 && left === right)
            ) {
                emptyTimed.push({ position: Math.max(left, right), source, word });
            }
            return;
        }
        const vocal = /[\p{L}\p{N}\p{M}]/u.test(word.text);
        const core = Array.from(word.text.matchAll(vocal ? /[\p{L}\p{N}\p{M}]/gu : /\S|\s/gu));
        const positions = core.map((character) => ({
            old: sourceOffset + character.index!,
            size: character[0].length,
        }));
        sourceOffset += word.text.length;
        if (
            !positions.length || positions.some(({ old, size }) =>
                mapping[old] < 0
                || Array.from({ length: size }, (_, index) => mapping[old + index] !== mapping[old] + index).some(
                    Boolean,
                )
            )
        ) return;
        const start = mapping[positions[0].old];
        const last = positions.at(-1)!;
        const end = mapping[last.old] + last.size;
        const coreText = (value: string) => vocal ? matchKey(value).replace(/[^\p{L}\p{N}\p{M}]/gu, "") : value;
        if (coreText(text.slice(start, end)) !== coreText(word.text)) return;
        const previous = anchors.at(-1);
        if (previous && previous.end > start) return;
        anchors.push({ start, end, source });
    });
    const boundaries = new Set([0, text.length, ...exactTokens(text).map((token) => token.end)]);
    for (const anchor of anchors) {
        for (const boundary of boundaries) {
            if (boundary > anchor.start && boundary < anchor.end) boundaries.delete(boundary);
        }
    }
    for (let index = 1; index < anchors.length; index++) {
        const previous = anchors[index - 1];
        const next = anchors[index];
        if (![...boundaries].some((boundary) => boundary >= previous.end && boundary <= next.start)) {
            boundaries.add(next.start);
        }
    }
    const sorted = [...boundaries].sort((left, right) => left - right);
    const words: TimedWord[] = [];
    const sources: (number | undefined)[] = [];
    let anchorIndex = 0;
    let emptyIndex = 0;
    for (let index = 1; index < sorted.length; index++) {
        const start = sorted[index - 1];
        const end = sorted[index];
        while (anchors[anchorIndex]?.end <= start) anchorIndex++;
        const anchor = anchors[anchorIndex];
        const source = anchor && anchor.start >= start && anchor.end <= end ? anchor.source : undefined;
        while (
            emptyTimed[emptyIndex] && (emptyTimed[emptyIndex].position <= start
                || (source !== undefined && emptyTimed[emptyIndex].source < source))
        ) {
            words.push(emptyTimed[emptyIndex].word);
            sources.push(emptyTimed[emptyIndex++].source);
        }
        const wordText = text.slice(start, end);
        words.push(source === undefined ? { text: wordText } : { ...line.words[source], text: wordText });
        sources.push(source);
    }
    for (; emptyIndex < emptyTimed.length; emptyIndex++) {
        words.push(emptyTimed[emptyIndex].word);
        sources.push(emptyTimed[emptyIndex].source);
    }
    return {
        ...line,
        endMs: sources.at(-1) === line.words.length - 1 ? line.endMs : words.at(-1)?.endMs,
        words,
    };
};
