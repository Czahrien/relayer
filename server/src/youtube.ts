import {
  EMBED_BLOCKED_MESSAGE,
  parseYouTubeUrl,
  youtubeThumbnailUrl,
  youtubeWatchUrl,
} from "@relayer/shared";
import { CommandError, type YoutubeItemInfo } from "./room.js";
import { cleanText } from "./validate.js";

export { parseYouTubeUrl };

export type YoutubeResolver = (url: string) => Promise<YoutubeItemInfo>;

const OEMBED_TIMEOUT_MS = 5000;

interface OEmbedResponse {
  title?: unknown;
  author_name?: unknown;
  thumbnail_url?: unknown;
}

/**
 * Parses a YouTube link and looks up its title, channel, and thumbnail through
 * oEmbed, which needs no API key. Duration comes later from a client (§7).
 */
export function createYoutubeResolver(fetchImpl: typeof fetch = fetch): YoutubeResolver {
  return async (url) => {
    const youtubeId = parseYouTubeUrl(url);
    if (!youtubeId) throw new CommandError("Only YouTube links are supported.");

    const fallback: YoutubeItemInfo = {
      youtubeId,
      title: "YouTube video",
      artUrl: youtubeThumbnailUrl(youtubeId),
    };
    const endpoint = `https://www.youtube.com/oembed?url=${encodeURIComponent(youtubeWatchUrl(youtubeId))}&format=json`;

    let response: Response;
    try {
      response = await fetchImpl(endpoint, { signal: AbortSignal.timeout(OEMBED_TIMEOUT_MS) });
    } catch {
      // YouTube is unreachable from the server; the player may still work for clients.
      return fallback;
    }
    if (response.status === 401 || response.status === 403) {
      return { ...fallback, error: EMBED_BLOCKED_MESSAGE };
    }
    if (response.status === 400 || response.status === 404) {
      throw new CommandError("That YouTube video doesn't exist or is private.");
    }
    if (!response.ok) return fallback;

    let body: OEmbedResponse;
    try {
      body = (await response.json()) as OEmbedResponse;
    } catch {
      return fallback;
    }
    const title = typeof body.title === "string" ? cleanText(body.title, 300) : "";
    const artist = typeof body.author_name === "string" ? cleanText(body.author_name, 300) : "";
    const thumb = typeof body.thumbnail_url === "string" && body.thumbnail_url.startsWith("https://")
      ? body.thumbnail_url
      : fallback.artUrl;
    return { youtubeId, title: title || fallback.title, artist: artist || undefined, artUrl: thumb };
  };
}
