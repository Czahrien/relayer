import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { parseFile, type IAudioMetadata } from "music-metadata";
import { isAudioName } from "@listening-room/shared";

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

const FOLDER_ART = /^(cover|folder|front|album)\.(jpe?g|png|webp)$/i;
const ART_MIME: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };

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
    const dir = path.dirname(await this.safePath(filePath));
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return null;
    }
    const name = names.sort().find((n) => FOLDER_ART.test(n));
    if (!name) return null;
    let real: string;
    try {
      real = await fs.realpath(path.join(dir, name));
    } catch {
      return null;
    }
    if (!(await this.isInside(real))) return null; // e.g. cover.jpg symlinked out of the library
    const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
    return { mime: ART_MIME[ext]!, read: () => fs.readFile(real) };
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
