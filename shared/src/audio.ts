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

export function isAudioName(name: string): boolean {
  const dot = name.lastIndexOf(".");
  return dot >= 0 && AUDIO_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}
