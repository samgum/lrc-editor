import type { State as LrcState, TrimOptios } from "@lrc-maker/lrc-parser";
import { parser } from "@lrc-maker/lrc-parser";
import { useReducer } from "react";

type InitArgs = Readonly<{
    text: string;
    options: TrimOptios;
    select: number;
}>;

export const enum ActionType {
    parse,
    replaceLyrics,
    refresh,
    next,
    time,
    info,
    select,
    deleteTime,
    getState,
    offsetAll,
    undo,
    redo,
}

interface IHistorySnapshot extends LrcState {
    readonly selectIndex: number;
}

export interface IState extends LrcState {
    readonly currentTime: number;
    readonly currentIndex: number;
    readonly nextTime: number;
    readonly nextIndex: number;
    readonly selectIndex: number;
    readonly historyPast: readonly IHistorySnapshot[];
    readonly historyFuture: readonly IHistorySnapshot[];
}

type Map$Type$Payload<T, U> = { [key in keyof T]: U extends key ? { type: key; payload: T[key] } : never }[keyof T];

export type Action = Map$Type$Payload<
    {
        [ActionType.parse]: { text: string; options: TrimOptios };
        [ActionType.replaceLyrics]: LrcState["lyric"];
        [ActionType.refresh]: number;
        [ActionType.next]: number;
        [ActionType.time]: number;
        [ActionType.info]: { name: string; value: string };
        [ActionType.select]: (index: number) => number;
        [ActionType.deleteTime]: undefined;
        [ActionType.getState]: (state: IState) => void;
        [ActionType.offsetAll]: number;
        [ActionType.undo]: undefined;
        [ActionType.redo]: undefined;
    },
    ActionType
>;

export const guard = (value: number, min: number, max: number): number => {
    if (value < min) return min;
    if (value > max) return max;
    return value;
};

export const lrcReducer = (state: IState, action: Action): IState => {
    switch (action.type) {
        case ActionType.parse: {
            const lrc = parser(action.payload.text, action.payload.options);
            const selectIndex = guard(state.selectIndex, 0, Math.max(0, lrc.lyric.length - 1));
            return { ...state, ...lrc, selectIndex, historyPast: [], historyFuture: [] };
        }

        case ActionType.replaceLyrics: {
            const lyric = action.payload.slice();
            const selectIndex = guard(state.selectIndex, 0, Math.max(0, lyric.length - 1));
            return commit(state, {
                ...state,
                lyric,
                selectIndex,
                currentTime: Infinity,
                currentIndex: -1,
                nextTime: -Infinity,
                nextIndex: -1,
            });
        }

        case ActionType.refresh: {
            const audioTime = action.payload;
            if (audioTime >= state.currentTime && audioTime < state.nextTime) return state;
            const record = state.lyric.reduce(
                (current, line, index) => {
                    if (line.time !== undefined) {
                        if (line.time < current.nextTime && line.time > audioTime) {
                            current.nextTime = line.time;
                            current.nextIndex = index;
                        }
                        if (line.time > current.currentTime && line.time <= audioTime) {
                            current.currentTime = line.time;
                            current.currentIndex = index;
                        }
                    }
                    return current;
                },
                { currentTime: -Infinity, currentIndex: -1, nextTime: Infinity, nextIndex: -1 },
            );
            return state.currentTime === record.currentTime && state.nextTime === record.nextTime
                ? state
                : { ...state, ...record };
        }

        case ActionType.next: {
            const timed = lrcReducer(state, { type: ActionType.time, payload: action.payload });
            return { ...timed, selectIndex: guard(state.selectIndex + 1, 0, state.lyric.length - 1) };
        }

        case ActionType.time: {
            const index = state.selectIndex;
            if (!state.lyric[index] || state.lyric[index].time === action.payload) return state;
            const lyric = state.lyric.slice();
            lyric[index] = { text: lyric[index].text, time: action.payload };
            return commit(state, { ...state, lyric, currentTime: action.payload, nextTime: -Infinity });
        }

        case ActionType.info: {
            const name = action.payload.name;
            const value = action.payload.value.trim();
            if ((state.info.get(name) || "") === value) return state;
            const info = new Map(state.info);
            value ? info.set(name, value) : info.delete(name);
            return { ...state, info };
        }

        case ActionType.select: {
            const selectIndex = guard(action.payload(state.selectIndex), 0, state.lyric.length - 1);
            return state.selectIndex === selectIndex ? state : { ...state, selectIndex };
        }

        case ActionType.deleteTime: {
            const index = state.selectIndex;
            if (state.lyric[index]?.time === undefined) return state;
            const lyric = state.lyric.slice();
            lyric[index] = { text: lyric[index].text };
            return commit(state, {
                ...state,
                lyric,
                currentTime: index === state.currentIndex ? Infinity : state.currentTime,
                nextTime: index === state.currentIndex ? -Infinity : state.nextTime,
            });
        }

        case ActionType.getState:
            action.payload(state);
            return state;

        case ActionType.offsetAll: {
            if (action.payload === 0) return state;
            const lyric = state.lyric.map((line) =>
                line.time === undefined ? line : { ...line, time: Math.max(0, line.time + action.payload) }
            );
            return commit(state, { ...state, lyric, currentTime: Infinity, nextTime: -Infinity });
        }

        case ActionType.undo: {
            const previous = state.historyPast.at(-1);
            if (!previous) return state;
            return restoreHistory(state, previous, state.historyPast.slice(0, -1), [
                snapshot(state),
                ...state.historyFuture,
            ]);
        }

        case ActionType.redo: {
            const next = state.historyFuture[0];
            if (!next) return state;
            return restoreHistory(
                state,
                next,
                [...state.historyPast, snapshot(state)].slice(-100),
                state.historyFuture.slice(1),
            );
        }
    }
};

export const initLrcState = (lazyInit: () => InitArgs): IState => {
    const initial = lazyInit();
    return {
        ...parser(initial.text, initial.options),
        currentTime: Infinity,
        currentIndex: -1,
        nextTime: -Infinity,
        nextIndex: -1,
        selectIndex: initial.select,
        historyPast: [],
        historyFuture: [],
    };
};

const snapshot = (state: IState): IHistorySnapshot => ({
    info: state.info,
    lyric: state.lyric,
    selectIndex: state.selectIndex,
});

const commit = (previous: IState, next: IState): IState => ({
    ...next,
    historyPast: [...previous.historyPast, snapshot(previous)].slice(-100),
    historyFuture: [],
});

const restoreHistory = (
    state: IState,
    target: IHistorySnapshot,
    historyPast: readonly IHistorySnapshot[],
    historyFuture: readonly IHistorySnapshot[],
): IState => ({
    ...state,
    ...target,
    historyPast,
    historyFuture: historyFuture.slice(0, 100),
    currentTime: Infinity,
    currentIndex: -1,
    nextTime: -Infinity,
    nextIndex: -1,
});

export const useLrc = (lazyInit: () => InitArgs): [IState, React.Dispatch<Action>] =>
    useReducer(lrcReducer, lazyInit, initLrcState);
