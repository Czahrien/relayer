// YouTube URL recognition. Shared so the client can reject non-YouTube links
// before sending, while the server remains the authority.

const ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
  "youtu.be",
  "www.youtu.be",
]);

function youtubeUrl(input: string): URL | null {
  let text = input.trim();
  if (!text) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  return HOSTS.has(url.hostname.toLowerCase()) ? url : null;
}

/**
 * Extracts the video ID from a YouTube URL, or returns null when the text is
 * not a recognizable YouTube video link. A video link that also names a
 * playlist ("watch?v=…&list=…") is the video.
 */
export function parseYouTubeUrl(input: string): string | null {
  const url = youtubeUrl(input);
  if (!url) return null;
  const host = url.hostname.toLowerCase();

  const segments = url.pathname.split("/").filter(Boolean);
  let id: string | null | undefined;
  if (host.endsWith("youtu.be")) {
    id = segments[0];
  } else if (segments[0] === "watch") {
    id = url.searchParams.get("v");
  } else if (segments[0] === "shorts" || segments[0] === "embed" || segments[0] === "live" || segments[0] === "v") {
    id = segments[1];
  }
  return id && ID_PATTERN.test(id) ? id : null;
}

/** Shown when a video's owner has disabled playback in embedded players. */
export const EMBED_BLOCKED_MESSAGE =
  "The owner doesn't allow this video on other sites. Try a different upload, such as a lyric video.";

const PLAYLIST_ID = /^[A-Za-z0-9_-]{10,64}$/;

/**
 * The playlist ID from a playlist link ("youtube.com/playlist?list=…", or the
 * same on music.youtube.com, as for YouTube Music albums), or null. Links to a
 * single video within a playlist count as the video, not the playlist.
 */
export function parseYouTubePlaylistUrl(input: string): string | null {
  const url = youtubeUrl(input);
  if (!url || parseYouTubeUrl(input)) return null;
  const list = url.searchParams.get("list");
  return list && PLAYLIST_ID.test(list) ? list : null;
}

/** Whether text is any YouTube link the app can add: a video or a playlist. */
export function isYouTubeLink(input: string): boolean {
  return !!parseYouTubeUrl(input) || !!parseYouTubePlaylistUrl(input);
}

export function youtubeWatchUrl(id: string): string {
  return `https://www.youtube.com/watch?v=${id}`;
}

export function youtubeThumbnailUrl(id: string): string {
  return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
}
