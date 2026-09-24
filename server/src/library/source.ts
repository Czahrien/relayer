import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { parseFile, type IAudioMetadata } from "music-metadata";
import { isAudioName } from "@listening-room/shared";
import { isDiscFolder } from "./tags.js";

/** A candidate audio file in a library source. */
export interface LibraryFile {
  /** Relative to the source root, "/"-separated. Never sent to clients. */
  path: string;
  size: number;
  /** Changes whenever the file does. Local: mtime; WebDAV: ETag or last-modified. */
  version: string;
}

export interface FolderArt {
  mime: string;
  read(): Promise<Buffer>;
}

/**
 * Everything the library does with files goes through a source, so a NAS or
 * WebDAV(S) backend can replace the local directory later (SPEC §10.2).
 */
export interface LibrarySource {
  /** Every candidate audio file (filtered by extension). */
  list(): AsyncIterable<LibraryFile>;
  /** Tags, duration, and codec, reading only what the parser needs. */
  readMetadata(file: LibraryFile, options: { covers: boolean }): Promise<IAudioMetadata>;
  /** The file's current size and version, or null if it's gone. */
  stat(filePath: string): Promise<{ size: number; version: string } | null>;
  /** A byte range of the file (inclusive), for serving with Range support. */
  open(filePath: string, range?: { start: number; end: number }): Promise<Readable>;
  /** A folder image (cover.jpg, folder.png, ...) next to the file, if any. */
  folderArt(filePath: string): Promise<FolderArt | null>;
}

const IMAGE = /\.(jpe?g|png|webp|gif|bmp)$/i;
const ART_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  bmp: "image/bmp",
};
const ART_SUBFOLDER = /^(artwork|art|covers?|scans?|images?|pictures?|pics)$/i;
const FRONT = /\b(front|cover|folder)\b/;
const ALBUM_ART = /\balbum ?art/;
/** Scans that aren't the front cover (Windows' AlbumArtSmall is a thumbnail). */
const NOT_FRONT = /\b(back|rear|inlay|inside|booklet|tray|obi|cd|disc|label|matrix|spine|thumb|thumbnail|small)\b/;

/**
 * How likely an image is the front cover: 3 names the front ("cover.jpg",
 * "Leviathan_-_Front.jpg"), 2 is Windows-style album art, 0 says nothing, and
 * -1 is some other scan (back, inlay, disc, booklet, thumbnail).
 */
function artScore(name: string): number {
  const words = name
    .replace(/\.[^.]+$/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2") // "AlbumArtSmall" → "Album Art Small"
    .toLowerCase()
    .replace(/[_\-.()[\]{}]+/g, " ");
  if (NOT_FRONT.test(words)) return -1;
  if (FRONT.test(words)) return 3;
  if (ALBUM_ART.test(words)) return 2;
  return 0;
}

async function listImages(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir, { withFileTypes: true }))
      .filter((e) => !e.isDirectory() && IMAGE.test(e.name) && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

async function listDirs(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * A library on the local filesystem, typically a read-only Docker bind mount.
 * Nothing outside the root is ever read, including through symlinks.
 */
export class LocalDirSource implements LibrarySource {
  private realRoot: string | null = null;

  constructor(private readonly root: string) {}

  async *list(): AsyncIterable<LibraryFile> {
    const root = await this.resolveRoot();
    // Real paths already visited, so symlink loops and duplicate links are skipped.
    const seen = new Set<string>();
    yield* this.walk(root, "", seen);
  }

  async readMetadata(file: LibraryFile, { covers }: { covers: boolean }): Promise<IAudioMetadata> {
    return parseFile(await this.safePath(file.path), { duration: true, skipCovers: !covers });
  }

  async stat(filePath: string): Promise<{ size: number; version: string } | null> {
    try {
      const stat = await fs.stat(await this.safePath(filePath));
      return stat.isFile() ? { size: stat.size, version: String(Math.trunc(stat.mtimeMs)) } : null;
    } catch {
      return null;
    }
  }

  async open(filePath: string, range?: { start: number; end: number }): Promise<Readable> {
    return createReadStream(await this.safePath(filePath), range);
  }

  async folderArt(filePath: string): Promise<FolderArt | null> {
    const trackDir = path.dirname(await this.safePath(filePath));
    // One disc of a set keeps its art next to the set: look in the parent too.
    const albumDirs = [trackDir];
    const parent = path.dirname(trackDir);
    if (isDiscFolder(path.basename(trackDir)) && (await this.isInside(parent))) albumDirs.push(parent);

    const candidates: { file: string; score: number; depth: number }[] = [];
    for (const dir of albumDirs) {
      const images = await listImages(dir);
      const usable = images.filter((name) => artScore(name) >= 0);
      for (const name of usable) {
        // A lone image beside the tracks is almost always the cover.
        const score = Math.max(artScore(name), usable.length === 1 ? 1 : 0);
        if (score > 0) candidates.push({ file: path.join(dir, name), score, depth: 0 });
      }
      // Artwork/, Covers/, Scans/: only images that say they're the front.
      for (const sub of await listDirs(dir)) {
        if (!ART_SUBFOLDER.test(sub)) continue;
        for (const name of await listImages(path.join(dir, sub))) {
          if (artScore(name) >= 2) candidates.push({ file: path.join(dir, sub, name), score: artScore(name), depth: 1 });
        }
      }
    }
    candidates.sort((a, b) => b.score - a.score || a.depth - b.depth || a.file.localeCompare(b.file));

    for (const candidate of candidates) {
      let real: string;
      try {
        real = await fs.realpath(candidate.file);
      } catch {
        continue;
      }
      if (!(await this.isInside(real))) continue; // e.g. cover.jpg symlinked out of the library
      const ext = candidate.file.slice(candidate.file.lastIndexOf(".") + 1).toLowerCase();
      return { mime: ART_MIME[ext]!, read: () => fs.readFile(real) };
    }
    return null;
  }

  private async *walk(dir: string, rel: string, seen: Set<string>): AsyncIterable<LibraryFile> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory
    }
    // Real entries before symlinks, so a file reachable both ways is indexed
    // under its real path.
    entries.sort((a, b) => Number(a.isSymbolicLink()) - Number(b.isSymbolicLink()) || a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      let real: string;
      let stat;
      try {
        real = await fs.realpath(full);
        stat = await fs.stat(real);
      } catch {
        continue; // broken symlink or vanished file
      }
      if (!(await this.isInside(real)) || seen.has(real)) continue;
      seen.add(real);
      if (stat.isDirectory()) {
        yield* this.walk(full, childRel, seen);
      } else if (stat.isFile() && isAudioName(entry.name)) {
        yield { path: childRel, size: stat.size, version: String(Math.trunc(stat.mtimeMs)) };
      }
    }
  }

  private async resolveRoot(): Promise<string> {
    this.realRoot ??= await fs.realpath(this.root);
    return this.realRoot;
  }

  private async isInside(realPath: string): Promise<boolean> {
    const root = await this.resolveRoot();
    return realPath === root || realPath.startsWith(root + path.sep);
  }

  /** The absolute path for a relative one, refusing anything that resolves outside the root. */
  private async safePath(filePath: string): Promise<string> {
    const root = await this.resolveRoot();
    const full = path.resolve(root, ...filePath.split("/"));
    const real = await fs.realpath(full);
    if (!(await this.isInside(real))) throw new Error(`Refusing a path outside the library: ${filePath}`);
    return real;
  }
}
