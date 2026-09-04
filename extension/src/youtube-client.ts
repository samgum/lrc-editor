export const youtubeClientRevision = "yt-dlp-2026.08.19";

export const youtubeAudioClients = ["VISIONOS", "WEB_EMBEDDED", "WEB", "MWEB"] as const;
export type YouTubeAudioClient = typeof youtubeAudioClients[number];

export interface YouTubePlaybackContext {
    videoId: string;
    visitorData: string;
    poToken?: string;
    embeddedClientVersion?: string;
}

const playerVersions: Readonly<Record<string, string>> = {
    VISIONOS: "1.02",
    WEB_EMBEDDED_PLAYER: "2.20260708.00.00",
    WEB: "2.20260708.00.00",
    MWEB: "2.20260708.05.00",
};

export const decodeYouTubeRequestBody = async (
    parts: readonly { bytes?: ArrayBuffer }[],
): Promise<string | null> => {
    const maximumBytes = 1_048_576;
    const buffers: Uint8Array<ArrayBuffer>[] = [];
    for (const part of parts) {
        if (part.bytes) buffers.push(new Uint8Array(part.bytes));
    }
    const size = buffers.reduce((total, bytes) => total + bytes.byteLength, 0);
    if (size === 0 || size > maximumBytes) return null;
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of buffers) {
        bytes.set(part, offset);
        offset += part.byteLength;
    }
    if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return new TextDecoder().decode(bytes);
    const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();
    const decoder = new TextDecoder();
    let text = "";
    let decodedSize = 0;
    try {
        while (true) {
            const chunk = await reader.read();
            if (chunk.done) return text + decoder.decode();
            decodedSize += chunk.value.byteLength;
            if (decodedSize > maximumBytes) {
                await reader.cancel();
                return null;
            }
            text += decoder.decode(chunk.value, { stream: true });
        }
    } catch {
        return null;
    } finally {
        reader.releaseLock();
    }
};

export const readYouTubePlaybackContext = (
    body: string,
    videoId: string,
): YouTubePlaybackContext | null => {
    try {
        const payload = JSON.parse(body) as {
            videoId?: unknown;
            context?: { client?: { visitorData?: unknown; clientName?: unknown; clientVersion?: unknown } };
            serviceIntegrityDimensions?: { poToken?: unknown };
        };
        const client = payload.context?.client;
        if (payload.videoId !== videoId || typeof client?.visitorData !== "string" || !client.visitorData) return null;
        const token = payload.serviceIntegrityDimensions?.poToken;
        return {
            videoId,
            visitorData: client.visitorData,
            poToken: typeof token === "string" && token.length > 0 ? token : undefined,
            embeddedClientVersion: client.clientName === "WEB_EMBEDDED_PLAYER"
                    && typeof client.clientVersion === "string" && /^\d+\.\d[\d.]*$/.test(client.clientVersion)
                ? client.clientVersion
                : undefined,
        };
    } catch {
        return null;
    }
};

export const youtubePlayerToken = (
    context: YouTubePlaybackContext | null,
    videoId: string,
    client: YouTubeAudioClient,
): string | undefined => context?.videoId === videoId && client !== "VISIONOS" ? context.poToken : undefined;

export const updateYouTubePlayerBody = (
    body: string,
    embedUrl: string,
    context: YouTubePlaybackContext | null,
): { body: string; clientVersion?: string } => {
    const payload = JSON.parse(body) as {
        videoId?: string;
        context?: { client?: Record<string, unknown>; thirdParty?: { embedUrl: string } };
    };
    const client = payload.context?.client;
    if (!client || typeof client.clientName !== "string") return { body };
    const observedVersion = context && context.videoId === payload.videoId ? context.embeddedClientVersion : undefined;
    const clientVersion = client.clientName === "WEB_EMBEDDED_PLAYER"
        ? observedVersion || playerVersions.WEB_EMBEDDED_PLAYER
        : playerVersions[client.clientName];
    if (!clientVersion) return { body };
    client.clientVersion = clientVersion;
    if (client.clientName === "WEB_EMBEDDED_PLAYER") payload.context!.thirdParty = { embedUrl };
    return { body: JSON.stringify(payload), clientVersion };
};

export const createYouTubeFetch = (
    embedUrl: string,
    context: YouTubePlaybackContext | null,
    fetcher: typeof fetch = fetch,
): typeof fetch =>
async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
    let body = init?.body;
    if (
        url.protocol === "https:" && (url.hostname === "www.youtube.com" || url.hostname === "youtubei.googleapis.com")
        && url.pathname === "/youtubei/v1/player" && typeof body === "string"
    ) {
        const updated = updateYouTubePlayerBody(body, embedUrl, context);
        body = updated.body;
        if (updated.clientVersion) headers.set("X-Youtube-Client-Version", updated.clientVersion);
    }
    headers.delete("Cookie");
    headers.delete("Authorization");
    return await fetcher(input, {
        ...init,
        body,
        headers,
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        signal: init?.signal || AbortSignal.timeout(12_000),
    });
};
