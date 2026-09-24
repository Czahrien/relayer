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

/**
 * A title (and track number, if the name clearly has one) for an untagged file.
 * "01 - diodo.mp3", "01. Intro.flac", "03_Sorry.wav", and "1-04 Song.m4a" give
 * track numbers; "99 Luftballons.mp3" and "2112.mp3" are left alone, since a
 * number is only taken when a separator (or a leading zero) marks it.
 */
export function parseFilename(name: string): { title: string; trackNo?: number } {
  const stem = name.replace(/\.[^.]+$/, "").replace(/_/g, " ").trim();
  const match =
    /^\d-(\d{2})\s+(.+)$/.exec(stem) ?? // disc-track, e.g. "1-04 Song"
    /^(\d{1,3})\s*(?:[-)]|\.\s)\s*(.+)$/.exec(stem) ?? // "01 - Song", "01) Song", "01. Song"
    /^(0\d{1,2})\s+(.+)$/.exec(stem); // "01 Song"
  const title = match?.[2]?.trim();
  if (match && title && /[\p{L}\p{N}]/u.test(title)) return { title, trackNo: Number(match[1]) };
  return { title: stem || name };
}

/** A readable title for an untagged file: its name without extension, underscores, or track number. */
export function titleFromFilename(name: string): string {
  return parseFilename(name).title;
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
