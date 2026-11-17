import { guard } from "../hooks/useLrc.js";
import { createPubSub } from "./pubsub.js";

interface IAudioRef extends React.RefObject<HTMLAudioElement> {
    readonly src: string;
    readonly duration: number;
    readonly paused: boolean;
    playbackRate: number;
    currentTime: number;
    toggle: () => void;
    step: (
        ev: React.MouseEvent | React.KeyboardEvent | MouseEvent | KeyboardEvent,
        value: number,
        target?: number,
    ) => number;
}

export const audioRef: IAudioRef = {
    current: null,

    get src() {
        return this.current?.src ?? "";
    },

    get duration() {
        const duration = this.current?.duration;
        return duration !== undefined && Number.isFinite(duration) && duration > 0 ? duration : 0;
    },

    get paused() {
        return this.current?.paused ?? true;
    },

    get playbackRate() {
        return this.current?.playbackRate ?? 1;
    },
    set playbackRate(rate: number) {
        if (this.current !== null && Number.isFinite(rate) && rate > 0) {
            this.current.playbackRate = rate;
        }
    },

    get currentTime() {
        const time = this.current?.currentTime;
        return time !== undefined && Number.isFinite(time) ? time : 0;
    },
    set currentTime(time: number) {
        if (this.current !== null && Number.isFinite(time) && this.duration > 0) {
            this.current.currentTime = guard(time, 0, this.duration);
        }
    },

    step(ev, value, target): number {
        if (target === undefined) {
            target = this.currentTime;
        }

        if (ev.altKey) {
            value *= 0.2;
        }
        if (ev.shiftKey) {
            value *= 0.5;
        }
        return (this.currentTime = guard(value + target, 0, this.duration));
    },

    toggle() {
        if (this.current && this.duration > 0) {
            if (this.current.paused) {
                void this.current.play().catch(() => undefined);
            } else {
                this.current.pause();
            }
        }
    },
};

export const enum AudioActionType {
    pause,
    getDuration,
    rateChange,
}

export type AudioState =
    | {
        type: AudioActionType.pause;
        payload: boolean;
    }
    | {
        type: AudioActionType.getDuration;
        payload: number;
    }
    | {
        type: AudioActionType.rateChange;
        payload: number;
    };

export const audioStatePubSub = createPubSub<AudioState>();
export const currentTimePubSub = createPubSub<number>();
