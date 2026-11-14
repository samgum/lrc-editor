import { describe, expect, it } from "vitest";
import { parseEnhancedLrc, toEnhancedLrc } from "../utils/advanced-lyrics.js";
import {
    AdvancedActionType,
    advancedLyricsReducer,
    initAdvancedLyricsState,
    nextWordCursor,
} from "./useAdvancedLyrics.js";

describe("advanced lyrics timing state", () => {
    it("inserts and deletes lines without shifting existing word timestamps", () => {
        let state = advancedLyricsReducer(initAdvancedLyricsState(""), {
            type: AdvancedActionType.load,
            payload: parseEnhancedLrc(
                "[00:02.40]<00:02.40>It's <00:02.79>been<00:03.00>\n[00:05.61]<00:05.61>That's <00:06.03>just<00:06.33>",
            ),
        });
        const original = state.document;
        state = advancedLyricsReducer(state, { type: AdvancedActionType.addLine, payload: 0 });
        expect(state.document?.lines).toHaveLength(3);
        expect(state.document?.lines[0]).toBe(original?.lines[0]);
        expect(state.document?.lines[2]).toBe(original?.lines[1]);
        expect(state.document?.lines[1]).toEqual({ words: [{ text: "" }] });
        expect(state.cursor).toEqual({ lineIndex: 1, wordIndex: 0 });
        state = advancedLyricsReducer(state, { type: AdvancedActionType.removeLine, payload: 1 });
        expect(state.document).toEqual(original);
        state = advancedLyricsReducer(state, { type: AdvancedActionType.undo, payload: undefined });
        expect(state.document?.lines).toHaveLength(3);
        state = advancedLyricsReducer(state, { type: AdvancedActionType.redo, payload: undefined });
        expect(state.document).toEqual(original);
    });

    it("can remove the last line, add a new one, and undo both operations", () => {
        let state = advancedLyricsReducer(initAdvancedLyricsState(""), {
            type: AdvancedActionType.load,
            payload: parseEnhancedLrc("[00:02.40]<00:02.40>hello<00:03.00>"),
        });
        const original = state.document;
        state = advancedLyricsReducer(state, { type: AdvancedActionType.removeLine, payload: 0 });
        expect(state.document?.lines).toEqual([]);
        state = advancedLyricsReducer(state, { type: AdvancedActionType.addLine, payload: -1 });
        expect(state.document?.lines).toEqual([{ words: [{ text: "" }] }]);
        state = advancedLyricsReducer(state, { type: AdvancedActionType.undo, payload: undefined });
        state = advancedLyricsReducer(state, { type: AdvancedActionType.undo, payload: undefined });
        expect(state.document).toEqual(original);
    });
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
        expect(state.cursor).toEqual({ lineIndex: 0, wordIndex: 1, end: true });
        expect(state.historyPast).toHaveLength(1);
    });

    it("preserves a completed line end when stamping the next line", () => {
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

        expect(state.document?.lines[0].endMs).toBe(2000);
        expect(state.document?.lines[1].startMs).toBe(3500);
        expect(state.document?.lines[1].words[0].startMs).toBe(3500);
    });

    it("captures a sustained last word with the same key before moving to the next line", () => {
        let state = advancedLyricsReducer(initAdvancedLyricsState(""), {
            type: AdvancedActionType.ensureWordMode,
            payload: { lines: [{ text: "fast rap" }, { text: "next line" }], metadata: new Map() },
        });
        state = advancedLyricsReducer(state, { type: AdvancedActionType.stamp, payload: 1000 });
        state = advancedLyricsReducer(state, { type: AdvancedActionType.stamp, payload: 1150 });
        expect(state.cursor).toEqual({ lineIndex: 0, wordIndex: 1, end: true });
        expect(state.document?.lines[1].words[0].startMs).toBeUndefined();
        const pending = state.document;
        state = advancedLyricsReducer(state, { type: AdvancedActionType.stamp, payload: 2500 });
        expect(state.cursor).toEqual({ lineIndex: 1, wordIndex: 0 });
        expect(state.document?.lines[0].words[1]).toMatchObject({ startMs: 1150, endMs: 2500 });
        expect(state.document?.lines[0].endMs).toBe(2500);
        expect(toEnhancedLrc(state.document!, 2)).toContain("rap<00:02.50>");
        expect(toEnhancedLrc(state.document!, 3)).toContain("rap<00:02.500>");
        const finished = state.document;
        state = advancedLyricsReducer(state, { type: AdvancedActionType.undo, payload: undefined });
        expect(state.document).toBe(pending);
        expect(state.cursor.end).toBe(true);
        state = advancedLyricsReducer(state, { type: AdvancedActionType.redo, payload: undefined });
        expect(state.document).toBe(finished);
        state = advancedLyricsReducer(state, { type: AdvancedActionType.stamp, payload: 4000 });
        expect(state.document?.lines[0].words[1].endMs).toBe(2500);
        expect(state.document?.lines[0].endMs).toBe(2500);
    });

    it("captures the final single-word line and restores an unfinished end step", () => {
        let state = advancedLyricsReducer(initAdvancedLyricsState(""), {
            type: AdvancedActionType.ensureWordMode,
            payload: { lines: [{ text: "yeah" }], metadata: new Map() },
        });
        state = advancedLyricsReducer(state, { type: AdvancedActionType.stamp, payload: 1000 });
        const savedCursor = JSON.parse(JSON.stringify(state.cursor));
        state = advancedLyricsReducer(initAdvancedLyricsState(JSON.stringify(state.document)), {
            type: AdvancedActionType.select,
            payload: savedCursor,
        });
        expect(state.cursor.end).toBe(true);
        state = advancedLyricsReducer(state, { type: AdvancedActionType.stamp, payload: 5000 });
        expect(state.document?.lines[0].words[0]).toMatchObject({ startMs: 1000, endMs: 5000 });
        expect(state.cursor).toEqual({ lineIndex: 0, wordIndex: 0 });
    });

    it("bounds an end capture by an already timed following word", () => {
        let state = advancedLyricsReducer(initAdvancedLyricsState(""), {
            type: AdvancedActionType.load,
            payload: parseEnhancedLrc("[00:01.000]<00:01.000>A\n[00:03.000]<00:03.000>B"),
        });
        state = advancedLyricsReducer(state, { type: AdvancedActionType.stamp, payload: 1500 });
        state = advancedLyricsReducer(state, { type: AdvancedActionType.stamp, payload: 4000 });
        expect(state.document?.lines[0].words[0]).toMatchObject({ startMs: 1500, endMs: 3000 });
        expect(state.document?.lines[1].words[0].startMs).toBe(3000);
    });

    it("keeps short rapid captures positive and ignores invalid clock values", () => {
        let state = advancedLyricsReducer(initAdvancedLyricsState(""), {
            type: AdvancedActionType.ensureWordMode,
            payload: { lines: [{ text: "rap" }], metadata: new Map() },
        });
        state = advancedLyricsReducer(state, { type: AdvancedActionType.stamp, payload: 1000 });
        expect(advancedLyricsReducer(state, { type: AdvancedActionType.stamp, payload: NaN })).toBe(state);
        state = advancedLyricsReducer(state, { type: AdvancedActionType.stamp, payload: 1000 });
        expect(state.document?.lines[0].words[0].endMs).toBe(1010);
    });

    it("lets selection cancel the end step and keeps hold-and-release at one gesture", () => {
        let state = advancedLyricsReducer(initAdvancedLyricsState(""), {
            type: AdvancedActionType.ensureWordMode,
            payload: { lines: [{ text: "rap" }, { text: "next" }], metadata: new Map() },
        });
        state = advancedLyricsReducer(state, { type: AdvancedActionType.stamp, payload: 1000 });
        expect(nextWordCursor(state.document!, state.cursor, 1)).toEqual({ lineIndex: 1, wordIndex: 0 });
        state = advancedLyricsReducer(state, {
            type: AdvancedActionType.select,
            payload: { lineIndex: 0, wordIndex: 0 },
        });
        expect(state.cursor.end).toBeUndefined();
        state = advancedLyricsReducer(state, { type: AdvancedActionType.startHold, payload: 1500 });
        state = advancedLyricsReducer(state, { type: AdvancedActionType.finishHold, payload: 2300 });
        expect(state.document?.lines[0].words[0]).toMatchObject({ startMs: 1500, endMs: 2300 });
        expect(state.cursor).toEqual({ lineIndex: 1, wordIndex: 0 });
    });

    it("records a held word start and end as one undoable gesture", () => {
        let state = advancedLyricsReducer(initAdvancedLyricsState(""), {
            type: AdvancedActionType.ensureWordMode,
            payload: { lines: [{ text: "fast rap" }], metadata: new Map() },
        });
        const document = state.document;
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

    it("never changes segment text while its timing is edited", () => {
        const document = parseEnhancedLrc(
            "[00:01.000]<00:01.000>我<00:01.200>爱<00:01.400>你<00:01.600>",
        );
        let state = advancedLyricsReducer(initAdvancedLyricsState(""), {
            type: AdvancedActionType.load,
            payload: document,
        });
        state = advancedLyricsReducer(state, {
            type: AdvancedActionType.updateWord,
            payload: { cursor: { lineIndex: 0, wordIndex: 1 }, patch: { startMs: 1250 } },
        });
        expect(state.document?.lines[0].words.map((word) => word.text).join("")).toBe("我爱你");
        expect(state.document?.lines[0].words[1]).toMatchObject({ text: "爱", startMs: 1250 });
    });

    it("keeps rapid captured starts monotonic instead of creating duplicates", () => {
        let state = advancedLyricsReducer(initAdvancedLyricsState(""), {
            type: AdvancedActionType.ensureWordMode,
            payload: { lines: [{ text: "快速" }], metadata: new Map() },
        });
        state = advancedLyricsReducer(state, { type: AdvancedActionType.stamp, payload: 1000 });
        state = advancedLyricsReducer(state, { type: AdvancedActionType.stamp, payload: 1000 });
        expect(state.document?.lines[0].words.map((word) => word.startMs)).toEqual([1000, 1010]);
        expect(state.document?.lines[0].words.map((word) => word.text).join("")).toBe("快速");
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
