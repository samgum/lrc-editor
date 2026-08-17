import { describe, expect, it } from "vitest";
import { ActionType, initLrcState, lrcReducer } from "./useLrc.js";

describe("LRC timing history", () => {
    it("undoes and redoes timestamp edits", () => {
        const initial = initLrcState(() => ({ text: "first\nsecond", options: {}, select: 0 }));
        const timed = lrcReducer(initial, { type: ActionType.time, payload: 1.25 });
        expect(timed.lyric[0].time).toBe(1.25);
        expect(timed.historyPast).toHaveLength(1);

        const undone = lrcReducer(timed, { type: ActionType.undo, payload: undefined });
        expect(undone.lyric[0].time).toBeUndefined();
        expect(undone.historyFuture).toHaveLength(1);

        const redone = lrcReducer(undone, { type: ActionType.redo, payload: undefined });
        expect(redone.lyric[0].time).toBe(1.25);
    });

    it("keeps playback refreshes out of the undo history", () => {
        const initial = initLrcState(() => ({ text: "[00:01.000]first", options: {}, select: 0 }));
        const refreshed = lrcReducer(initial, { type: ActionType.refresh, payload: 1.1 });
        expect(refreshed.historyPast).toHaveLength(0);
    });

    it("advances after capture and restores the working line on undo", () => {
        const initial = initLrcState(() => ({ text: "first\nsecond", options: {}, select: 0 }));
        const captured = lrcReducer(initial, { type: ActionType.next, payload: 2.5 });
        expect(captured.lyric[0].time).toBe(2.5);
        expect(captured.selectIndex).toBe(1);

        const undone = lrcReducer(captured, { type: ActionType.undo, payload: undefined });
        expect(undone.lyric[0].time).toBeUndefined();
        expect(undone.selectIndex).toBe(0);
    });
});
