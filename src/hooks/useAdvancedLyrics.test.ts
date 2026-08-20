import { describe, expect, it } from "vitest";
import { parseEnhancedLrc } from "../utils/advanced-lyrics.js";
import {
    AdvancedActionType,
    advancedLyricsReducer,
    initAdvancedLyricsState,
    nextWordCursor,
} from "./useAdvancedLyrics.js";

describe("advanced lyrics timing state", () => {
    it("stamps word starts, closes the previous word, and advances", () => {
        const document = parseEnhancedLrc("[00:01.000]<00:01.000>Hello <00:02.000>world<00:03.000>");
        let state = advancedLyricsReducer(initAdvancedLyricsState(""), {
            type: AdvancedActionType.load,
            payload: document,
        });
        state = advancedLyricsReducer(state, {
            type: AdvancedActionType.select,
            payload: { lineIndex: 0, wordIndex: 1 },
        });
        state = advancedLyricsReducer(state, { type: AdvancedActionType.stamp, payload: 2400 });

        expect(state.document?.lines[0].words[0].endMs).toBe(2400);
        expect(state.document?.lines[0].words[1].startMs).toBe(2400);
        expect(state.cursor).toEqual({ lineIndex: 0, wordIndex: 1 });
        expect(state.historyPast).toHaveLength(1);
    });

    it("updates line boundaries when stamping across lines", () => {
        const document = parseEnhancedLrc([
            "[00:01.000]<00:01.000>A<00:02.000>",
            "[00:03.000]<00:03.000>B<00:04.000>",
        ].join("\n"));
        let state = advancedLyricsReducer(initAdvancedLyricsState(""), {
            type: AdvancedActionType.load,
            payload: document,
        });
        state = advancedLyricsReducer(state, {
            type: AdvancedActionType.select,
            payload: { lineIndex: 1, wordIndex: 0 },
        });
        state = advancedLyricsReducer(state, { type: AdvancedActionType.stamp, payload: 3500 });

        expect(state.document?.lines[0].endMs).toBe(3500);
        expect(state.document?.lines[1].startMs).toBe(3500);
        expect(state.document?.lines[1].words[0].startMs).toBe(3500);
    });

    it("records a held word start and end as one undoable gesture", () => {
        const document = parseEnhancedLrc("[00:01.000]<00:01.000>fast <00:01.200>rap<00:01.400>");
        let state = advancedLyricsReducer(initAdvancedLyricsState(""), {
            type: AdvancedActionType.load,
            payload: document,
        });
        state = advancedLyricsReducer(state, { type: AdvancedActionType.startHold, payload: 2000 });
        expect(state.document?.lines[0].words[0].startMs).toBe(2000);
        expect(state.cursor).toEqual({ lineIndex: 0, wordIndex: 0 });
        state = advancedLyricsReducer(state, { type: AdvancedActionType.finishHold, payload: 2250 });
        expect(state.document?.lines[0].words[0]).toMatchObject({ startMs: 2000, endMs: 2250 });
        expect(state.cursor).toEqual({ lineIndex: 0, wordIndex: 1 });
        state = advancedLyricsReducer(state, { type: AdvancedActionType.undo, payload: undefined });
        expect(state.document).toEqual(document);
    });

    it("undoes and redoes word edits independently", () => {
        const document = parseEnhancedLrc("[00:01.000]<00:01.000>A<00:02.000>");
        let state = advancedLyricsReducer(initAdvancedLyricsState(""), {
            type: AdvancedActionType.load,
            payload: document,
        });
        state = advancedLyricsReducer(state, {
            type: AdvancedActionType.updateWord,
            payload: { cursor: { lineIndex: 0, wordIndex: 0 }, patch: { text: "B" } },
        });
        expect(state.document?.lines[0].words[0].text).toBe("B");
        state = advancedLyricsReducer(state, { type: AdvancedActionType.undo, payload: undefined });
        expect(state.document?.lines[0].words[0].text).toBe("A");
        state = advancedLyricsReducer(state, { type: AdvancedActionType.redo, payload: undefined });
        expect(state.document?.lines[0].words[0].text).toBe("B");
    });

    it("navigates across line boundaries", () => {
        const document = parseEnhancedLrc([
            "[00:01.000]<00:01.000>A<00:02.000>B<00:03.000>",
            "[00:04.000]<00:04.000>C<00:05.000>",
        ].join("\n"));
        expect(nextWordCursor(document, { lineIndex: 0, wordIndex: 1 }, 1)).toEqual({ lineIndex: 1, wordIndex: 0 });
        expect(nextWordCursor(document, { lineIndex: 1, wordIndex: 0 }, -1)).toEqual({ lineIndex: 0, wordIndex: 1 });
    });

    it("adds and removes editable word segments without losing the surrounding line", () => {
        const document = parseEnhancedLrc("[00:01.000]<00:01.000>A<00:02.000>B<00:03.000>");
        let state = advancedLyricsReducer(initAdvancedLyricsState(""), {
            type: AdvancedActionType.load,
            payload: document,
        });
        state = advancedLyricsReducer(state, {
            type: AdvancedActionType.addWord,
            payload: { lineIndex: 0, wordIndex: 0 },
        });
        expect(state.document?.lines[0].words.map((word) => word.text)).toEqual(["A", "", "B"]);
        expect(state.cursor).toEqual({ lineIndex: 0, wordIndex: 1 });
        state = advancedLyricsReducer(state, {
            type: AdvancedActionType.removeWord,
            payload: state.cursor,
        });
        expect(state.document?.lines[0].words.map((word) => word.text)).toEqual(["A", "B"]);
    });

    it("keeps the active word while reconciling new line timing", () => {
        let state = advancedLyricsReducer(initAdvancedLyricsState(""), {
            type: AdvancedActionType.ensureWordMode,
            payload: { lines: [{ text: "fast rap" }], metadata: new Map() },
        });
        state = advancedLyricsReducer(state, {
            type: AdvancedActionType.select,
            payload: { lineIndex: 0, wordIndex: 1 },
        });
        state = advancedLyricsReducer(state, {
            type: AdvancedActionType.ensureWordMode,
            payload: { lines: [{ time: 2, text: "fast rap" }], metadata: new Map() },
        });
        expect(state.cursor).toEqual({ lineIndex: 0, wordIndex: 1 });
        expect(state.document?.lines[0].startMs).toBe(2000);
        expect(state.document?.lines[0].words.every((word) => word.startMs === undefined)).toBe(true);
    });

    it("creates and clears a one-step evenly distributed timing draft", () => {
        const document = parseEnhancedLrc("[00:01.000]<00:01.000>fast <00:01.300>rap <00:01.700>line<00:02.000>");
        let state = advancedLyricsReducer(initAdvancedLyricsState(""), {
            type: AdvancedActionType.load,
            payload: document,
        });
        state = advancedLyricsReducer(state, {
            type: AdvancedActionType.distributeLine,
            payload: { lineIndex: 0, startMs: 1000, endMs: 2500 },
        });
        expect(state.document?.lines[0].words.map((word) => [word.startMs, word.endMs])).toEqual([
            [1000, 1500],
            [1500, 2000],
            [2000, 2500],
        ]);
        state = advancedLyricsReducer(state, {
            type: AdvancedActionType.clearLineFromCursor,
            payload: { lineIndex: 0, wordIndex: 1 },
        });
        expect(state.document?.lines[0].words[0].startMs).toBe(1000);
        expect(state.document?.lines[0].words.slice(1).every((word) => word.startMs === undefined)).toBe(true);
    });
});
