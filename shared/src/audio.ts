/** File extensions the app treats as audio (uploads and the server library). */
export const AUDIO_EXTENSIONS: ReadonlySet<string> = new Set([
  "mp3",
  "m4a",
  "aac",
  "flac",
  "ogg",
  "oga",
  "opus",
  "wav",
  "webm",
]);

/** A readable title for an untagged file: its name without extension or underscores. */
export function titleFromFilename(name: string): string {
  const stem = name.replace(/\.[^.]+$/, "");
  return stem.replace(/_/g, " ").trim() || name;
}

/**
 * The artist tag as written. music-metadata splits ID3v2.3 artists on "/", so
 * "AC/DC" would read as "AC"; joining the list restores it. (A genuine
 * multi-artist tag shows as "A/B", which is fine.)
 */
export function joinedArtist(common: { artist?: string; artists?: string[] }): string | undefined {
  const joined = common.artists?.filter(Boolean).join("/");
  return joined || common.artist || undefined;
}

export function isAudioName(name: string): boolean {
  const dot = name.lastIndexOf(".");
  return dot >= 0 && AUDIO_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}
