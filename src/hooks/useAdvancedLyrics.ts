import { useReducer } from "react";
import { type AdvancedLyricsDocument, createWordTimedDocument, type TimedWord } from "../utils/advanced-lyrics.js";

export interface WordCursor {
    readonly lineIndex: number;
    readonly wordIndex: number;
}

interface Snapshot {
    readonly document: AdvancedLyricsDocument;
    readonly cursor: WordCursor;
}

export interface AdvancedLyricsState {
    readonly document: AdvancedLyricsDocument | null;
    readonly cursor: WordCursor;
    readonly historyPast: readonly Snapshot[];
    readonly historyFuture: readonly Snapshot[];
}

export const enum AdvancedActionType {
    load,
    reconcile,
    ensureWordMode,
    select,
    stamp,
    deleteTime,
    adjustTime,
    updateWord,
    updateLine,
    addWord,
    removeWord,
    undo,
    redo,
}

export type AdvancedLyricsAction =
    | { readonly type: AdvancedActionType.load; readonly payload: AdvancedLyricsDocument | null }
    | { readonly type: AdvancedActionType.reconcile; readonly payload: AdvancedLyricsDocument | null }
    | {
        readonly type: AdvancedActionType.ensureWordMode;
        readonly payload: {
            readonly lines: readonly { readonly text: string; readonly time?: number }[];
            readonly metadata: ReadonlyMap<string, string>;
        };
    }
    | { readonly type: AdvancedActionType.select; readonly payload: WordCursor }
    | { readonly type: AdvancedActionType.stamp; readonly payload: number }
    | { readonly type: AdvancedActionType.deleteTime; readonly payload: undefined }
    | { readonly type: AdvancedActionType.adjustTime; readonly payload: number }
    | {
        readonly type: AdvancedActionType.updateWord;
        readonly payload: { readonly cursor: WordCursor; readonly patch: Partial<TimedWord> };
    }
    | {
        readonly type: AdvancedActionType.updateLine;
        readonly payload: {
            readonly lineIndex: number;
            readonly patch: Partial<Pick<import("../utils/advanced-lyrics.js").AdvancedLyricLine, "startMs" | "endMs">>;
        };
    }
    | { readonly type: AdvancedActionType.addWord; readonly payload: WordCursor }
    | { readonly type: AdvancedActionType.removeWord; readonly payload: WordCursor }
    | { readonly type: AdvancedActionType.undo; readonly payload: undefined }
    | { readonly type: AdvancedActionType.redo; readonly payload: undefined };

const initialCursor: WordCursor = { lineIndex: 0, wordIndex: 0 };

export const initAdvancedLyricsState = (serialized: string): AdvancedLyricsState => {
    try {
        const document = JSON.parse(serialized) as AdvancedLyricsDocument;
        if (isAdvancedDocument(document)) {
            return { document, cursor: initialCursor, historyPast: [], historyFuture: [] };
        }
    } catch {
        // Ignore missing or older advanced state.
    }
    return { document: null, cursor: initialCursor, historyPast: [], historyFuture: [] };
};

export const advancedLyricsReducer = (
    state: AdvancedLyricsState,
    action: AdvancedLyricsAction,
): AdvancedLyricsState => {
    switch (action.type) {
        case AdvancedActionType.load:
            return {
                document: action.payload,
                cursor: initialCursor,
                historyPast: [],
                historyFuture: [],
            };
        case AdvancedActionType.reconcile:
            return state.document === action.payload
                ? state
                : { ...state, document: action.payload, cursor: clampCursor(action.payload, state.cursor) };
        case AdvancedActionType.ensureWordMode: {
            const document = createWordTimedDocument(action.payload.lines, action.payload.metadata, state.document);
            return state.document === document
                ? state
                : { ...state, document, cursor: clampCursor(document, state.cursor) };
        }
        case AdvancedActionType.select:
            return { ...state, cursor: clampCursor(state.document, action.payload) };
        case AdvancedActionType.stamp:
            return updateTiming(state, Math.max(0, Math.round(action.payload)), true);
        case AdvancedActionType.deleteTime:
            return updateCurrentWord(state, (word) => ({ text: word.text }), false);
        case AdvancedActionType.adjustTime: {
            const word = currentWord(state);
            if (!word || word.startMs === undefined) return state;
            return updateTiming(state, Math.max(0, word.startMs + Math.round(action.payload)), false);
        }
        case AdvancedActionType.updateWord:
            return updateWordAt(state, action.payload.cursor, (word) => ({ ...word, ...action.payload.patch }));
        case AdvancedActionType.updateLine: {
            const document = state.document;
            const line = document?.lines[action.payload.lineIndex];
            if (!document || !line) return state;
            const lines = document.lines.slice();
            lines[action.payload.lineIndex] = { ...line, ...action.payload.patch };
            return commit(state, { ...document, lines }, state.cursor);
        }
        case AdvancedActionType.addWord: {
            const document = state.document;
            const line = document?.lines[action.payload.lineIndex];
            if (!document || !line) return state;
            const wordIndex = Math.min(action.payload.wordIndex + 1, line.words.length);
            const words = line.words.slice();
            words.splice(wordIndex, 0, { text: "" });
            const lines = document.lines.slice();
            lines[action.payload.lineIndex] = { ...line, words };
            return commit(state, { ...document, lines }, { lineIndex: action.payload.lineIndex, wordIndex });
        }
        case AdvancedActionType.removeWord: {
            const document = state.document;
            const line = document?.lines[action.payload.lineIndex];
            if (!document || !line) return state;
            const words = line.words.slice();
            if (words.length === 1) words[0] = { text: "" };
            else words.splice(action.payload.wordIndex, 1);
            const lines = document.lines.slice();
            lines[action.payload.lineIndex] = { ...line, words };
            return commit(state, { ...document, lines }, {
                lineIndex: action.payload.lineIndex,
                wordIndex: Math.min(action.payload.wordIndex, words.length - 1),
            });
        }
        case AdvancedActionType.undo: {
            const previous = state.historyPast.at(-1);
            if (!previous || !state.document) return state;
            return {
                document: previous.document,
                cursor: previous.cursor,
                historyPast: state.historyPast.slice(0, -1),
                historyFuture: [{ document: state.document, cursor: state.cursor }, ...state.historyFuture].slice(
                    0,
                    100,
                ),
            };
        }
        case AdvancedActionType.redo: {
            const next = state.historyFuture[0];
            if (!next || !state.document) return state;
            return {
                document: next.document,
                cursor: next.cursor,
                historyPast: [...state.historyPast, { document: state.document, cursor: state.cursor }].slice(-100),
                historyFuture: state.historyFuture.slice(1),
            };
        }
    }
};

export const useAdvancedLyrics = (serialized: string): [AdvancedLyricsState, React.Dispatch<AdvancedLyricsAction>] =>
    useReducer(advancedLyricsReducer, serialized, initAdvancedLyricsState);

export const nextWordCursor = (
    document: AdvancedLyricsDocument,
    cursor: WordCursor,
    offset: -1 | 1,
): WordCursor => {
    if (offset === 1) {
        const line = document.lines[cursor.lineIndex];
        if (cursor.wordIndex + 1 < (line?.words.length || 0)) return { ...cursor, wordIndex: cursor.wordIndex + 1 };
        for (let lineIndex = cursor.lineIndex + 1; lineIndex < document.lines.length; lineIndex += 1) {
            if (document.lines[lineIndex].words.length > 0) return { lineIndex, wordIndex: 0 };
        }
        return cursor;
    }
    if (cursor.wordIndex > 0) return { ...cursor, wordIndex: cursor.wordIndex - 1 };
    for (let lineIndex = cursor.lineIndex - 1; lineIndex >= 0; lineIndex -= 1) {
        const words = document.lines[lineIndex].words;
        if (words.length > 0) return { lineIndex, wordIndex: words.length - 1 };
    }
    return cursor;
};

const updateTiming = (state: AdvancedLyricsState, startMs: number, advance: boolean): AdvancedLyricsState => {
    const document = state.document;
    const line = document?.lines[state.cursor.lineIndex];
    const word = line?.words[state.cursor.wordIndex];
    if (!document || !line || !word) return state;

    let nextDocument = replaceWord(document, state.cursor, { ...word, startMs });
    const previousCursor = nextWordCursor(document, state.cursor, -1);
    if (previousCursor.lineIndex !== state.cursor.lineIndex || previousCursor.wordIndex !== state.cursor.wordIndex) {
        const previous = nextDocument.lines[previousCursor.lineIndex].words[previousCursor.wordIndex];
        nextDocument = replaceWord(nextDocument, previousCursor, { ...previous, endMs: startMs });
        if (previousCursor.lineIndex !== state.cursor.lineIndex) {
            nextDocument = replaceLine(nextDocument, previousCursor.lineIndex, {
                ...nextDocument.lines[previousCursor.lineIndex],
                endMs: startMs,
            });
        }
    }
    if (state.cursor.wordIndex === 0) {
        nextDocument = replaceLine(nextDocument, state.cursor.lineIndex, {
            ...nextDocument.lines[state.cursor.lineIndex],
            startMs,
        });
    }
    const cursor = advance ? nextWordCursor(nextDocument, state.cursor, 1) : state.cursor;
    return commit(state, nextDocument, cursor);
};

const updateCurrentWord = (
    state: AdvancedLyricsState,
    updater: (word: TimedWord) => TimedWord,
    advance: boolean,
): AdvancedLyricsState => {
    const document = state.document;
    const word = currentWord(state);
    if (!document || !word) return state;
    const nextDocument = replaceWord(document, state.cursor, updater(word));
    return commit(state, nextDocument, advance ? nextWordCursor(nextDocument, state.cursor, 1) : state.cursor);
};

const updateWordAt = (
    state: AdvancedLyricsState,
    cursor: WordCursor,
    updater: (word: TimedWord) => TimedWord,
): AdvancedLyricsState => {
    const document = state.document;
    const word = document?.lines[cursor.lineIndex]?.words[cursor.wordIndex];
    if (!document || !word) return state;
    const nextDocument = replaceWord(document, cursor, updater(word));
    return commit(state, nextDocument, cursor);
};

const currentWord = (state: AdvancedLyricsState): TimedWord | undefined =>
    state.document?.lines[state.cursor.lineIndex]?.words[state.cursor.wordIndex];

const replaceWord = (
    document: AdvancedLyricsDocument,
    cursor: WordCursor,
    word: TimedWord,
): AdvancedLyricsDocument => {
    const line = document.lines[cursor.lineIndex];
    const words = line.words.slice();
    words[cursor.wordIndex] = word;
    return replaceLine(document, cursor.lineIndex, { ...line, words });
};

const replaceLine = (
    document: AdvancedLyricsDocument,
    lineIndex: number,
    line: AdvancedLyricsDocument["lines"][number],
): AdvancedLyricsDocument => {
    const lines = document.lines.slice();
    lines[lineIndex] = line;
    return { ...document, timingMode: "word", lines };
};

const commit = (
    state: AdvancedLyricsState,
    document: AdvancedLyricsDocument,
    cursor: WordCursor,
): AdvancedLyricsState => {
    if (!state.document) return { document, cursor, historyPast: [], historyFuture: [] };
    return {
        document,
        cursor,
        historyPast: [...state.historyPast, { document: state.document, cursor: state.cursor }].slice(-100),
        historyFuture: [],
    };
};

const clampCursor = (document: AdvancedLyricsDocument | null, cursor: WordCursor): WordCursor => {
    if (!document || document.lines.length === 0) return initialCursor;
    const lineIndex = Math.max(0, Math.min(cursor.lineIndex, document.lines.length - 1));
    const wordIndex = Math.max(0, Math.min(cursor.wordIndex, Math.max(0, document.lines[lineIndex].words.length - 1)));
    return { lineIndex, wordIndex };
};

const isAdvancedDocument = (value: unknown): value is AdvancedLyricsDocument => {
    if (typeof value !== "object" || value === null) return false;
    const candidate = value as Partial<AdvancedLyricsDocument>;
    return Array.isArray(candidate.lines)
        && (candidate.timingMode === "line" || candidate.timingMode === "word")
        && typeof candidate.metadata === "object";
};
