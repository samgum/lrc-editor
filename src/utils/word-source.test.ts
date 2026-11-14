import { describe, expect, it } from "vitest";
import { AdvancedActionType, advancedLyricsReducer, initAdvancedLyricsState } from "../hooks/useAdvancedLyrics.js";
import { lineText, parseEnhancedLrc, toEnhancedLrc } from "./advanced-lyrics.js";
import { parseWordEditorSource } from "./word-source.js";

describe("Enhanced LRC source editing", () => {
    const source =
        "[ti:Song]\n[00:02.40]<00:02.40>It's <00:02.79>been <00:02.97>a <00:03.17>couple <00:03.64>months<00:04.51>\n[00:05.61]<00:05.61>Next <00:06.03>line<00:06.33>";

    it("preserves untouched tags and lines when editing text and timestamps", () => {
        const original = parseWordEditorSource(source);
        const edited = parseWordEditorSource(source.replace("couple", "few").replace("<00:02.79>", "<00:02.85>"));
        expect(lineText(edited.lines[0])).toBe("It's been a few months");
        expect(edited.lines[0].words.map((word) => word.startMs)).toEqual([2400, 2850, 2970, 3170, 3640]);
        expect(edited.lines[0].endMs).toBe(4510);
        expect(edited.lines.slice(1)).toEqual(original.lines.slice(1));
        expect(edited.metadata).toEqual(original.metadata);
    });

    it("supports inserting and deleting whole source lines without moving other word axes", () => {
        const original = parseWordEditorSource(source);
        const lines = source.split("\n");
        lines.splice(2, 0, "New untimed English line 日本語");
        const added = parseWordEditorSource(lines.join("\n"));
        expect(added.lines[2]).toEqual(original.lines[1]);
        expect(lineText(added.lines[1])).toBe("New untimed English line 日本語");
        expect(added.lines[1].words.every((word) => word.startMs === undefined)).toBe(true);
        expect(added.lines[1].words.length).toBeGreaterThan(1);
        lines.splice(2, 1);
        expect(parseWordEditorSource(lines.join("\n"))).toEqual(original);
    });

    it("keeps source edits in document history and allows clearing all lyrics and metadata", () => {
        const original = parseWordEditorSource(source);
        let state = advancedLyricsReducer(initAdvancedLyricsState(""), {
            type: AdvancedActionType.load,
            payload: original,
        });
        const empty = parseWordEditorSource("");
        state = advancedLyricsReducer(state, { type: AdvancedActionType.editDocument, payload: empty });
        expect(state.document).toBe(empty);
        expect(state.document?.lines).toEqual([]);
        expect(state.document?.metadata).toEqual({});
        expect(state.document?.timingMode).toBe("word");
        state = advancedLyricsReducer(state, { type: AdvancedActionType.undo, payload: undefined });
        expect(state.document).toEqual(original);
        state = advancedLyricsReducer(state, { type: AdvancedActionType.redo, payload: undefined });
        expect(state.document).toBe(empty);
    });

    it("round-trips imported syllables, punctuation, and mixed-script timings", () => {
        const text = "[00:01.000]<00:01.000>(\"I <00:01.250>can<00:01.500>not <00:02.000>見える\")<00:03.000>";
        expect(parseEnhancedLrc(toEnhancedLrc(parseWordEditorSource(text)))).toEqual(parseEnhancedLrc(text));
    });
});
