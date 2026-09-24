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
