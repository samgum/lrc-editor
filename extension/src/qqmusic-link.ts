import { isQQMusicSongMid } from "../../src/shared/media-extension-protocol.js";

export class QQMusicNotPlayableError extends Error {
    constructor() {
        super("QQ Music only offers a preview for this track");
        this.name = QQMusicNotPlayableError.name;
    }
}

export interface QQMusicAudio {
    duration: number;
    mimeType: string;
    url: string;
}

export const parseQQMusicPlaybackPage = (html: string, expectedSongMid: string): QQMusicAudio => {
    if (!isQQMusicSongMid(expectedSongMid)) throw new TypeError("Invalid QQ Music songmid");
    const serialized = /window\.__ssrFirstPageData__\s*=\s*("(?:\\.|[^"\\])*")/.exec(html)?.[1];
    if (!serialized) throw new Error("QQ Music playback data was missing");

    let payload: unknown;
    try {
        const json = JSON.parse(serialized) as unknown;
        if (typeof json !== "string") throw new TypeError("QQ Music playback data was invalid");
        payload = JSON.parse(json) as unknown;
    } catch {
        throw new Error("QQ Music playback data was invalid");
    }
    if (!isRecord(payload) || !isRecord(payload.song)) {
        throw new Error("QQ Music song data was missing");
    }

    const song = payload.song;
    const pay = isRecord(song.pay) ? song.pay : {};
    const action = isRecord(song.action) ? song.action : {};
    const duration = typeof song.interval === "number" ? song.interval : Number.NaN;
    if (
        song.mid !== expectedSongMid || pay.pay_play !== 0 || action.play !== true || action.vip !== false
        || typeof song.playUrl !== "string" || !Number.isFinite(duration) || duration <= 0
    ) {
        throw new QQMusicNotPlayableError();
    }

    const audioUrl = new URL(song.playUrl);
    const host = audioUrl.hostname.toLowerCase();
    if (
        (audioUrl.protocol !== "http:" && audioUrl.protocol !== "https:")
        || host !== "aqqmusic.tc.qq.com" || audioUrl.username !== "" || audioUrl.password !== ""
        || /^\/RS\d/i.test(audioUrl.pathname)
    ) {
        throw new Error("QQ Music returned an unexpected audio URL");
    }
    audioUrl.protocol = "https:";
    const mimeType = audioUrl.pathname.toLowerCase().endsWith(".m4a")
        ? "audio/mp4"
        : audioUrl.pathname.toLowerCase().endsWith(".mp3")
        ? "audio/mpeg"
        : null;
    if (!mimeType) throw new Error("QQ Music returned an unsupported audio format");

    return { duration, mimeType, url: audioUrl.href };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
