// Cleaning up what real libraries put in album tags and folder names.

/**
 * A disc marker at the end of an album title or folder name: "Moonmadness - CD 1",
 * "The Anthology, CD2", "Stars Die (Disc 2)", or a bare "CD2" folder. The marker
 * must start a word, so "ABCD 1" and "Disco 2000" don't count.
 */
const DISC_SUFFIX = /[\s,;:\-–—]*[([]?\s*(?<![\p{L}\p{N}])(?:cd|disc|disk)\s*(\d{1,2})\s*[)\]]?\s*$/iu;

/** Splits a trailing disc marker off an album title. A title that is only a marker is kept. */
export function splitDisc(album: string): { title: string; disc?: number } {
  const match = DISC_SUFFIX.exec(album);
  const title = match ? album.slice(0, match.index).trim() : "";
  return match && title ? { title, disc: Number(match[1]) } : { title: album };
}

/** Whether a folder holds one disc of a set ("CD2", "Disc 1", "666 - CD 2"). */
export function isDiscFolder(name: string): boolean {
  return DISC_SUFFIX.test(name);
}

/** Folder names that don't name an album. */
const NOT_AN_ALBUM = /^(unknown album|unknown|misc(ellaneous)?|singles|various|unsorted|new folder|music|mp3s?|flac)$/i;

const fold = (text: string) => text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().trim();

/**
 * An album name for a track with no album tag, from its folder:
 * "(1971) Distortions [MP3 192kbps]" → "Distortions", and
 * "Uriah Heep - Demons And Wizards (1972) [FLAC]" → "Demons And Wizards".
 * Disc folders count as their parent. Returns undefined for tracks at the top
 * level, loose in their artist's folder, or in placeholder folders.
 */
export function albumFromFolder(trackPath: string, artist?: string): string | undefined {
  const parts = trackPath.split("/").slice(0, -1);
  if (parts.length > 1 && isDiscFolder(parts.at(-1)!)) parts.pop();
  const folder = parts.at(-1);
  if (!folder) return undefined;

  let name = folder
    .replace(/\[[^\]]*\]|\{[^}]*\}/g, " ") // [MP3 320kbps], [FLAC], {1996 Castle Remaster}
    .replace(/^\s*[([]?\d{4}[)\]]?\s*[-–.:]?\s*/, "") // leading (1971), 1995 -, 1971.
    .replace(/\s*[([]\d{4}[)\]]\s*$/, "") // trailing (1972)
    .replace(/\s+/g, " ")
    .trim();
  // "Uriah Heep - Demons And Wizards": drop the artist prefix. Without an artist
  // tag, the parent folder usually is the artist ("Uriah Heep/Uriah Heep - ...").
  for (const prefix of [artist, parts.at(-2)]) {
    if (!prefix) continue;
    const pattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[-–:]\\s*`, "i");
    name = name.replace(pattern, "").trim();
  }
  name = name.replace(/^[-–.:\s]+|[-–.:\s]+$/g, "");
  if (!name || NOT_AN_ALBUM.test(name)) return undefined;
  // Loose tracks in the artist's own folder aren't an album.
  if (artist && fold(name) === fold(artist)) return undefined;
  if (parts.length === 1 && !artist) return undefined; // e.g. "Loose/track.mp3": no way to tell
  return name;
}
