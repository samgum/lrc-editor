import { describe, expect, it, vi } from "vitest";
import {
    matchYouTubeMusicSong,
    musicSongTitle,
    readYouTubeMusicQueue,
    resolveYouTubeMusicTrack,
    type YouTubeMusicTrack,
} from "./youtube-music.js";

const artist = { name: "JENNIE", channelId: "UCAl7xQ6q0PEgZMQD7zr4AKQ" };
const video: YouTubeMusicTrack = {
    videoId: "s466YCiHfKw",
    title: "FALLEN ANGEL (Official Video)",
    artists: [artist],
    type: "MUSIC_VIDEO_TYPE_OMV",
};
const song: YouTubeMusicTrack = {
    videoId: "cOARkf5ZmtI",
    title: "FALLEN ANGEL",
    artists: [artist],
    type: "MUSIC_VIDEO_TYPE_ATV",
    albumId: "MPREb_k5ySekCYEqV",
};
const renderer = (track: YouTubeMusicTrack) => ({
    videoId: track.videoId,
    title: { runs: [{ text: track.title }] },
    longBylineText: {
        runs: track.artists.map((artist) => ({
            text: artist.name,
            navigationEndpoint: { browseEndpoint: { browseId: artist.channelId } },
        })),
    },
    navigationEndpoint: {
        watchEndpoint: {
            videoId: track.videoId,
            watchEndpointMusicSupportedConfigs: { watchEndpointMusicConfig: { musicVideoType: track.type } },
        },
    },
});
const response = (entries: unknown[]) => ({
    contents: {
        singleColumnMusicWatchNextResultsRenderer: {
            tabbedRenderer: {
                watchNextTabbedResultsRenderer: {
                    tabs: [
                        {
                            tabRenderer: {
                                content: {
                                    musicQueueRenderer: { content: { playlistPanelRenderer: { contents: entries } } },
                                },
                            },
                        },
                    ],
                },
            },
        },
    },
});

describe("YouTube Music song identity", () => {
    it("reads only the requested video, not a recommendation or a stale selected row", () => {
        const data = response([
            { playlistPanelVideoRenderer: { ...renderer(song), selected: true } },
            { playlistPanelVideoRenderer: renderer(video) },
        ]);
        expect(readYouTubeMusicQueue(data, video.videoId)?.track).toEqual(video);
        expect(readYouTubeMusicQueue(data, "78wrful9cVU")).toBeUndefined();
    });

    it("keeps an official song/video counterpart bound to its exact wrapper", async () => {
        const next = vi.fn().mockResolvedValue(response([{
            playlistPanelVideoWrapperRenderer: {
                primaryRenderer: { playlistPanelVideoRenderer: renderer(song) },
                counterpart: [{ counterpartRenderer: { playlistPanelVideoRenderer: renderer(video) } }],
            },
        }]));
        const search = vi.fn();
        expect((await resolveYouTubeMusicTrack(video.videoId, next, search))?.videoId).toBe(song.videoId);
        expect(search).not.toHaveBeenCalled();
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ videoId: video.videoId, isAudioOnly: true }));
    });

    it("leaves an existing song link unchanged and never searches for a replacement", async () => {
        const next = vi.fn().mockResolvedValue(response([{ playlistPanelVideoRenderer: renderer(song) }]));
        const search = vi.fn();
        expect((await resolveYouTubeMusicTrack(song.videoId, next, search))?.videoId).toBe(song.videoId);
        expect(search).not.toHaveBeenCalled();
    });

    it("finds the exact album song when a new MV has no counterpart mapping yet", async () => {
        const next = vi.fn().mockResolvedValue(response([{ playlistPanelVideoRenderer: renderer(video) }]));
        const search = vi.fn().mockResolvedValue([song]);
        expect(await resolveYouTubeMusicTrack(video.videoId, next, search)).toEqual(song);
        expect(search).toHaveBeenCalledWith("FALLEN ANGEL JENNIE");
    });

    it("requires the same artist channel, not just a matching title or artist display name", () => {
        const cover = { ...song, artists: [{ ...artist, channelId: "UC1234567890123456789012" }] };
        expect(matchYouTubeMusicSong(video, [cover])).toBeUndefined();
        expect(matchYouTubeMusicSong(video, [{ ...song, artists: [] }])).toBeUndefined();
        expect(matchYouTubeMusicSong({ ...video, artists: [] }, [song])).toBeUndefined();
    });

    it.each(["FALLEN ANGEL (Live)", "FALLEN ANGEL (Remix)", "FALLEN ANGEL (Instrumental)", "FALLEN ANGEL (Sped Up)"])(
        "does not substitute another recording: %s",
        (title) => {
            expect(matchYouTubeMusicSong(video, [{ ...song, title }])).toBeUndefined();
            expect(matchYouTubeMusicSong({ ...video, title: `${title} (Official Video)` }, [song])).toBeUndefined();
        },
    );

    it("rejects ambiguous matches, invalid IDs, videos and non-album results", () => {
        expect(matchYouTubeMusicSong(video, [song, { ...song, videoId: "78wrful9cVU" }])).toBeUndefined();
        expect(matchYouTubeMusicSong(video, [{ ...song, videoId: "invalid" }])).toBeUndefined();
        expect(matchYouTubeMusicSong(video, [{ ...song, type: "MUSIC_VIDEO_TYPE_OMV" }])).toBeUndefined();
        expect(matchYouTubeMusicSong(video, [{ ...song, albumId: undefined }])).toBeUndefined();
        expect(matchYouTubeMusicSong(video, [song, song])).toEqual(song);
    });

    it("normalizes presentation suffixes without removing musical version qualifiers", () => {
        expect(musicSongTitle({ ...video, title: "JENNIE - FALLEN ANGEL (Official Music Video)" })).toBe(song.title);
        expect(musicSongTitle({ ...video, title: "FALLEN ANGEL (Live)" })).toBe("FALLEN ANGEL (Live)");
        expect(
            matchYouTubeMusicSong({ ...video, title: "Ｉ’m Here (Official Video)" }, [{ ...song, title: "I'm Here" }])
                ?.videoId,
        ).toBe(song.videoId);
    });

    it("ignores malformed and unplayable rows without taking the next recommendation", async () => {
        const bad = { ...renderer(video), unplayableText: { simpleText: "Unavailable" } };
        const next = vi.fn().mockResolvedValue(
            response([{ playlistPanelVideoRenderer: bad }, { playlistPanelVideoRenderer: renderer(song) }]),
        );
        const search = vi.fn();
        expect(await resolveYouTubeMusicTrack(video.videoId, next, search)).toBeUndefined();
        expect(search).not.toHaveBeenCalled();
        for (const invalid of [null, {}, [], { contents: [] }]) {
            expect(readYouTubeMusicQueue(invalid, video.videoId)).toBeUndefined();
        }
    });

    it("does not search for a studio recording of a user-uploaded performance", async () => {
        const next = vi.fn().mockResolvedValue(
            response([{ playlistPanelVideoRenderer: renderer({ ...video, type: "MUSIC_VIDEO_TYPE_UGC" }) }]),
        );
        const search = vi.fn();
        expect(await resolveYouTubeMusicTrack(video.videoId, next, search)).toBeUndefined();
        expect(search).not.toHaveBeenCalled();
    });
});
