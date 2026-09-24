import { EMBED_BLOCKED_MESSAGE, youtubeThumbnailUrl, type YouTubeResult } from "@relayer/shared";
import { CommandError } from "./room.js";

// The YouTube Data API v3, for search and playlists (SPEC §14). Called only
// from the server, so the key never reaches browsers. Playback still goes
// through YouTube's embedded player.

const API = "https://www.googleapis.com/youtube/v3";
const TIMEOUT_MS = 8000;
const SEARCH_RESULTS = 15;
const SEARCH_CACHE_MS = 10 * 60_000;
const SEARCH_CACHE_SIZE = 200;
/** Longest playlist added at once, matching the library's batch limit. */
export const MAX_PLAYLIST_ITEMS = 500;

export const QUOTA_MESSAGE =
  "This server has used up its YouTube searches for today. Pasting YouTube links still works.";

/** A video's details, and why it can't be played in the embedded player, if it can't. */
export interface YouTubeVideo extends YouTubeResult {
  unplayable?: string;
}

export interface YouTubePlaylist {
  /** "Electric Warrior" for a YouTube Music album titled "Album - Electric Warrior". */
  title?: string;
  /** Playable videos, in playlist order. */
  videos: YouTubeVideo[];
  /** Videos left out: deleted, private, unavailable, or not embeddable. */
  skipped: number;
}

type Json = Record<string, any>;

/** "PT1H2M3S" → 3723000 ms; zero or unparseable (e.g. live streams) → undefined. */
export function parseIsoDuration(value: string | undefined): number | undefined {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value ?? "");
  if (!match) return undefined;
  const [, d = "0", h = "0", m = "0", s = "0"] = match;
  const ms = Math.round((((Number(d) * 24 + Number(h)) * 60 + Number(m)) * 60 + Number(s)) * 1000);
  return ms > 0 ? ms : undefined;
}

export class YouTubeData {
  private readonly searches = new Map<string, { at: number; results: YouTubeResult[] }>();

  constructor(
    private readonly key: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  /** Embeddable videos matching a query, with durations; cached for 10 minutes. */
  async search(query: string): Promise<YouTubeResult[]> {
    const q = query.trim().replace(/\s+/g, " ");
    const cacheKey = q.toLowerCase();
    const cached = this.searches.get(cacheKey);
    if (cached && this.now() - cached.at < SEARCH_CACHE_MS) return cached.results;

    const found = await this.call("search", {
      part: "id",
      type: "video",
      videoEmbeddable: "true",
      videoSyndicated: "true",
      maxResults: String(SEARCH_RESULTS),
      q,
    });
    const ids: string[] = (found.items ?? []).map((i: Json) => i.id?.videoId).filter(Boolean);
    const results = (await this.videos(ids))
      .filter((v) => !v.unplayable)
      .map(({ unplayable: _, ...result }) => result);

    this.searches.set(cacheKey, { at: this.now(), results });
    if (this.searches.size > SEARCH_CACHE_SIZE) this.searches.delete(this.searches.keys().next().value!);
    return results;
  }

  /** Details for videos, in the order given; unavailable ones are left out. */
  async videos(ids: string[]): Promise<YouTubeVideo[]> {
    const byId = new Map<string, YouTubeVideo>();
    for (let i = 0; i < ids.length; i += 50) {
      const page = await this.call("videos", {
        part: "snippet,contentDetails,status",
        id: ids.slice(i, i + 50).join(","),
        maxResults: "50",
      });
      for (const item of page.items ?? []) byId.set(item.id, toVideo(item));
    }
    return ids.map((id) => byId.get(id)).filter((v): v is YouTubeVideo => !!v);
  }

  async video(id: string): Promise<YouTubeVideo | undefined> {
    return (await this.videos([id]))[0];
  }

  /** A playlist's playable videos in order, e.g. a YouTube Music album. */
  async playlist(listId: string): Promise<YouTubePlaylist> {
    const info = await this.call("playlists", { part: "snippet", id: listId, maxResults: "1" });
    const playlist = info.items?.[0];
    if (!playlist) throw new CommandError("That playlist doesn't exist, or it's private.");

    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const page: Json = await this.call("playlistItems", {
        part: "contentDetails",
        playlistId: listId,
        maxResults: "50",
        ...(pageToken ? { pageToken } : {}),
      });
      for (const item of page.items ?? []) if (item.contentDetails?.videoId) ids.push(item.contentDetails.videoId);
      pageToken = page.nextPageToken;
    } while (pageToken && ids.length < MAX_PLAYLIST_ITEMS);

    const listed = ids.slice(0, MAX_PLAYLIST_ITEMS);
    const videos = (await this.videos(listed)).filter((v) => !v.unplayable);
    const title = String(playlist.snippet?.title ?? "").replace(/^Album\s+[-–]\s+/i, "").trim();
    return { title: title || undefined, videos, skipped: listed.length - videos.length };
  }

  private async call(endpoint: string, params: Record<string, string>): Promise<Json> {
    const url = new URL(`${API}/${endpoint}`);
    for (const [k, v] of Object.entries({ ...params, key: this.key })) url.searchParams.set(k, v);
    let response: Response;
    try {
      response = await this.fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      throw new CommandError("YouTube didn't respond. Try again in a moment.");
    }
    const body = (await response.json().catch(() => ({}))) as Json;
    if (response.ok) return body;

    const reason: string | undefined = body.error?.errors?.[0]?.reason;
    if (reason === "quotaExceeded" || reason === "dailyLimitExceeded" || reason === "rateLimitExceeded") {
      throw new CommandError(QUOTA_MESSAGE);
    }
    if (reason === "playlistNotFound" || response.status === 404) {
      throw new CommandError("That playlist doesn't exist, or it's private.");
    }
    if (reason === "playlistOperationUnsupported") {
      throw new CommandError("That kind of playlist (such as a YouTube mix) can't be added.");
    }
    throw new CommandError("YouTube search isn't working on this server right now.");
  }
}

function toVideo(item: Json): YouTubeVideo {
  const snippet = item.snippet ?? {};
  const details = item.contentDetails ?? {};
  const video: YouTubeVideo = {
    youtubeId: item.id,
    title: snippet.title ?? "YouTube video",
    channel: typeof snippet.channelTitle === "string" ? snippet.channelTitle.replace(/\s+-\s+Topic$/, "") : undefined,
    durationMs: parseIsoDuration(details.duration),
    thumbnail: snippet.thumbnails?.medium?.url ?? snippet.thumbnails?.high?.url ?? youtubeThumbnailUrl(item.id),
  };
  if (item.status?.embeddable === false) video.unplayable = EMBED_BLOCKED_MESSAGE;
  else if (details.contentRating?.ytRating === "ytAgeRestricted") {
    video.unplayable = "This video is age-restricted, so it can't play outside YouTube.";
  } else if (snippet.liveBroadcastContent && snippet.liveBroadcastContent !== "none") {
    video.unplayable = "Live streams can't be added to the queue.";
  }
  return video;
}
