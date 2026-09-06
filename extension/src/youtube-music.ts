import { isYouTubeVideoId } from "../../src/shared/media-extension-protocol.js";

export interface YouTubeMusicTrack {
    videoId: string;
    title: string;
    artists: { name: string; channelId: string }[];
    type: string;
    albumId?: string;
}

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue =>
    value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const at = (value: unknown, ...path: string[]): unknown => path.reduce((node, key) => record(node)[key], value);
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown): string => {
    const simple = record(value).simpleText;
    if (typeof simple === "string") return simple;
    return array(record(value).runs).map((run) => typeof record(run).text === "string" ? record(run).text : "").join(
        "",
    );
};

const parseTrack = (value: unknown): YouTubeMusicTrack | undefined => {
    const data = record(value);
    const endpoint = at(data, "navigationEndpoint", "watchEndpoint");
    const videoId = data.videoId;
    if (!isYouTubeVideoId(videoId) || data.unplayableText) return undefined;
    if (record(endpoint).videoId && record(endpoint).videoId !== videoId) return undefined;
    const title = text(data.title).trim();
    if (!title) return undefined;
    const runs = array(at(data.longBylineText ?? data.shortBylineText, "runs"));
    const artists: YouTubeMusicTrack["artists"] = [];
    for (const run of runs) {
        const browse = at(run, "navigationEndpoint", "browseEndpoint");
        const channelId = record(browse).browseId;
        const name = record(run).text;
        if (typeof channelId === "string" && /^UC[\w-]{22}$/.test(channelId) && typeof name === "string") {
            artists.push({ name, channelId });
        }
    }
    const type = at(endpoint, "watchEndpointMusicSupportedConfigs", "watchEndpointMusicConfig", "musicVideoType");
    return { videoId, title, artists, type: typeof type === "string" ? type : "" };
};

export const readYouTubeMusicQueue = (
    response: unknown,
    videoId: string,
): { track: YouTubeMusicTrack; counterparts: YouTubeMusicTrack[] } | undefined => {
    const tabs = array(
        at(
            response,
            "contents",
            "singleColumnMusicWatchNextResultsRenderer",
            "tabbedRenderer",
            "watchNextTabbedResultsRenderer",
            "tabs",
        ),
    );
    for (const tab of tabs) {
        const entries = array(
            at(tab, "tabRenderer", "content", "musicQueueRenderer", "content", "playlistPanelRenderer", "contents"),
        );
        for (const entry of entries) {
            const wrapper = record(entry).playlistPanelVideoWrapperRenderer;
            const primary = parseTrack(
                wrapper
                    ? at(wrapper, "primaryRenderer", "playlistPanelVideoRenderer")
                    : record(entry).playlistPanelVideoRenderer,
            );
            const counterparts: YouTubeMusicTrack[] = [];
            for (const item of array(record(wrapper).counterpart)) {
                const track = parseTrack(at(item, "counterpartRenderer", "playlistPanelVideoRenderer"));
                if (track) counterparts.push(track);
            }
            const tracks = [primary, ...counterparts].filter((track): track is YouTubeMusicTrack => !!track);
            const track = tracks.find((candidate) => candidate.videoId === videoId);
            if (track) return { track, counterparts: tracks.filter((candidate) => candidate.videoId !== videoId) };
        }
    }
    return undefined;
};

const normalize = (value: string): string =>
    value.normalize("NFKC").replace(/[‘’]/g, "'").replace(/[“”]/g, "\"").replace(/\s+/g, " ").trim().toLowerCase();

export const musicSongTitle = (track: YouTubeMusicTrack): string => {
    let title = track.title.replace(
        /\s*[[(](?:official\s+)?(?:music\s+video|video|mv|audio|lyric\s+video|visuali[sz]er)[\])]\s*$/i,
        "",
    ).trim();
    for (const artist of track.artists) {
        const prefix = `${artist.name} - `;
        if (normalize(title).startsWith(normalize(prefix) + " ")) title = title.slice(prefix.length);
    }
    return title;
};

export const matchYouTubeMusicSong = (
    source: YouTubeMusicTrack,
    candidates: readonly YouTubeMusicTrack[],
): YouTubeMusicTrack | undefined => {
    if (source.type !== "MUSIC_VIDEO_TYPE_OMV" || !source.artists.length) return undefined;
    const artistIds = [...new Set(source.artists.map((artist) => artist.channelId))].sort().join(",");
    const title = normalize(musicSongTitle(source));
    const matches = candidates.filter((candidate) =>
        candidate.type === "MUSIC_VIDEO_TYPE_ATV" && isYouTubeVideoId(candidate.videoId)
        && candidate.albumId?.startsWith("MPRE") && normalize(candidate.title) === title
        && [...new Set(candidate.artists.map((artist) => artist.channelId))].sort().join(",") === artistIds
    );
    const unique = new Map(matches.map((candidate) => [candidate.videoId, candidate]));
    return unique.size === 1 ? [...unique.values()][0] : undefined;
};

export const resolveYouTubeMusicTrack = async (
    videoId: string,
    next: (payload: RecordValue) => Promise<unknown>,
    searchSongs: (query: string) => Promise<YouTubeMusicTrack[]>,
): Promise<YouTubeMusicTrack | undefined> => {
    const queue = readYouTubeMusicQueue(
        await next({
            videoId,
            playlistId: `RDAMVM${videoId}`,
            enablePersistentPlaylistPanel: true,
            isAudioOnly: true,
            tunerSettingValue: "AUTOMIX_SETTING_NORMAL",
            watchEndpointMusicSupportedConfigs: {
                watchEndpointMusicConfig: { hasPersistentPlaylistPanel: true, musicVideoType: "MUSIC_VIDEO_TYPE_ATV" },
            },
        }),
        videoId,
    );
    if (!queue || queue.track.type === "MUSIC_VIDEO_TYPE_ATV") return queue?.track;
    const songs = queue.counterparts.filter((track) => track.type === "MUSIC_VIDEO_TYPE_ATV");
    if (songs.length === 1) return songs[0];
    if (queue.track.type !== "MUSIC_VIDEO_TYPE_OMV" || !queue.track.artists.length) return undefined;
    return matchYouTubeMusicSong(
        queue.track,
        await searchSongs(
            `${musicSongTitle(queue.track)} ${queue.track.artists.map((artist) => artist.name).join(" ")}`,
        ),
    );
};
