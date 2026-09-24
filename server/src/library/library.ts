import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { selectCover, type IAudioMetadata } from "music-metadata";
import {
  joinedArtist,
  titleFromFilename,
  type LibraryAlbumInfo,
  type LibraryArtistInfo,
  type LibrarySearchResult,
  type LibraryTrackInfo,
} from "@listening-room/shared";
import { classifyFormat, imageMime } from "../media.js";
import { indexFields, normalize, parseQuery, rank, type IndexedField } from "./search.js";
import type { LibraryFile, LibrarySource } from "./source.js";

/** An indexed track. `path`, `size`, and `version` stay on the server. */
export interface LibraryTrack extends LibraryTrackInfo {
  path: string;
  size: number;
  version: string;
  albumArtist?: string;
  /** The Content-Type to serve, from the codec check. */
  mime: string;
}

interface Album extends LibraryAlbumInfo {
  /** Ordered by disc, track, then filename. */
  tracks: LibraryTrack[];
  /** Folder the album lives in (multi-disc subfolders collapse into their parent). */
  dir: string;
  fields: IndexedField[];
}

interface Artist extends LibraryArtistInfo {
  key: string;
  fields: IndexedField[];
}

/** Cached album art. `key` records what the art came from, so it's re-extracted when that changes. */
interface AlbumArt {
  key: string;
  file: string | null; // null: the album has no art
  mime?: string;
}

/** A file that wasn't indexed, remembered so rescans don't re-read it until it changes. */
interface SkippedFile {
  size: number;
  version: string;
  reason: "unplayable" | "unreadable";
}

interface CacheFile {
  version: 1;
  tracks: LibraryTrack[];
  skipped: Record<string, SkippedFile>;
  art: Record<string, AlbumArt>;
}

export interface ScanResult {
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
  /** Audio files whose codec browsers can't play (SPEC §7). */
  unplayable: number;
  /** Files that couldn't be parsed at all. */
  unreadable: number;
  ms: number;
}

export interface LibraryLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface LibraryOptions {
  source: LibrarySource;
  /** The index cache and album art live here (DATA_DIR). */
  dataDir: string;
  /** Files parsed at once while scanning. */
  concurrency?: number;
  log?: LibraryLogger;
}

const LIMITS = { artists: 10, albums: 20, tracks: 50 };
const MAX_TEXT = 300;
const MULTI_DISC_DIR = /^(cd|disc|disk)\s*\d+$/i;
const VARIOUS_ARTISTS = "Various Artists";
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

const hash = (text: string) => createHash("sha1").update(text).digest("hex").slice(0, 16);

function clean(value: string | undefined | null): string | undefined {
  const text = value?.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
  return text || undefined;
}

function compareTracks(a: LibraryTrack, b: LibraryTrack): number {
  return (
    (a.discNo ?? 1) - (b.discNo ?? 1) ||
    (a.trackNo ?? Number.MAX_SAFE_INTEGER) - (b.trackNo ?? Number.MAX_SAFE_INTEGER) ||
    collator.compare(a.path, b.path)
  );
}

function albumDir(trackPath: string): string {
  const parts = trackPath.split("/").slice(0, -1);
  if (parts.length > 1 && MULTI_DISC_DIR.test(parts.at(-1)!)) parts.pop();
  return parts.join("/");
}

/** The client-facing view of a track: no path. */
function trackInfo(t: LibraryTrack): LibraryTrackInfo {
  const { id, title, artist, album, albumId, discNo, trackNo, year, durationMs } = t;
  return { id, title, artist, album, albumId, discNo, trackNo, year, durationMs };
}

function albumInfo(a: Album): LibraryAlbumInfo {
  const { id, title, artist, year, trackCount, durationMs, hasArt } = a;
  return { id, title, artist, year, trackCount, durationMs, hasArt };
}

function artistInfo(a: Artist): LibraryArtistInfo {
  const { name, albumCount, trackCount } = a;
  return { name, albumCount, trackCount };
}

/**
 * The server music library (SPEC §10): an incremental index of browser-playable
 * files from a source, with album art and in-memory search.
 */
export class Library {
  /** Where tracks are read from; rooms serve referenced tracks through it. */
  readonly source: LibrarySource;
  private readonly cacheFile: string;
  private readonly artDir: string;
  private readonly concurrency: number;
  private readonly log?: LibraryLogger;

  private tracks = new Map<string, LibraryTrack>();
  /** By track ID (hash of the path). */
  private skipped = new Map<string, SkippedFile>();
  private art = new Map<string, AlbumArt>();
  /** Albums, artists, and search fields; rebuilt lazily after the tracks change. */
  private views: {
    albums: Map<string, Album>;
    artists: Map<string, Artist>;
    trackFields: Map<string, IndexedField[]>;
  } | null = null;
  private scanning: Promise<ScanResult> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: LibraryOptions) {
    this.source = options.source;
    this.cacheFile = path.join(options.dataDir, "library-index.json");
    this.artDir = path.join(options.dataDir, "library-art");
    this.concurrency = options.concurrency ?? 4;
    this.log = options.log;
  }

  get indexing(): boolean {
    return this.scanning !== null;
  }

  get trackCount(): number {
    return this.tracks.size;
  }

  /** Loads the cached index from a previous run, if any. */
  async load(): Promise<void> {
    let cache: CacheFile;
    try {
      cache = JSON.parse(await fs.readFile(this.cacheFile, "utf8")) as CacheFile;
    } catch {
      return; // no cache yet, or unreadable: the scan rebuilds it
    }
    if (cache.version !== 1 || !Array.isArray(cache.tracks)) return;
    this.tracks = new Map(cache.tracks.map((t) => [t.id, t]));
    this.skipped = new Map(Object.entries(cache.skipped ?? {}));
    this.art = new Map(Object.entries(cache.art ?? {}));
    this.views = null;
  }

  /** Loads the cache, scans, and rescans every `rescanMs`. */
  start(rescanMs: number): void {
    const scan = () =>
      this.scan().catch((err: unknown) => this.log?.warn(`Library scan failed: ${String(err)}`));
    void this.load().then(scan);
    this.timer = setInterval(scan, rescanMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Rescans the source. Concurrent calls share one scan. */
  scan(): Promise<ScanResult> {
    this.scanning ??= this.runScan().finally(() => (this.scanning = null));
    return this.scanning;
  }

  // ---- Queries ----

  track(id: string): LibraryTrack | undefined {
    this.getViews(); // assigns albumId
    return this.tracks.get(id);
  }

  search(text: string): LibrarySearchResult {
    const query = parseQuery(text);
    if (!query) return { artists: [], albums: [], tracks: [] };
    const { albums, artists, trackFields } = this.getViews();
    return {
      artists: rank(query, artists.values(), (a) => a.fields, LIMITS.artists, (a, b) =>
        collator.compare(a.name, b.name),
      ).map(artistInfo),
      albums: rank(query, albums.values(), (a) => a.fields, LIMITS.albums, (a, b) =>
        collator.compare(a.title, b.title),
      ).map(albumInfo),
      tracks: rank(
        query,
        this.tracks.values(),
        (t) => trackFields.get(t.id)!,
        LIMITS.tracks,
        (a, b) =>
          collator.compare(a.artist ?? "", b.artist ?? "") ||
          collator.compare(a.album ?? "", b.album ?? "") ||
          compareTracks(a, b),
      ).map(trackInfo),
    };
  }

  album(id: string): { album: LibraryAlbumInfo; tracks: LibraryTrackInfo[] } | undefined {
    const album = this.getViews().albums.get(id);
    return album && { album: albumInfo(album), tracks: album.tracks.map(trackInfo) };
  }

  /** Track IDs of an album, in play order. */
  albumTrackIds(id: string): string[] | undefined {
    return this.getViews().albums.get(id)?.tracks.map((t) => t.id);
  }

  artist(name: string):
    | { artist: LibraryArtistInfo; albums: LibraryAlbumInfo[]; tracks: LibraryTrackInfo[] }
    | undefined {
    const key = normalize(name).trim();
    const { albums, artists } = this.getViews();
    const artist = artists.get(key);
    if (!artist) return undefined;
    const tracks = [...this.tracks.values()]
      .filter((t) => [t.artist, t.albumArtist].some((n) => n && normalize(n).trim() === key))
      .sort((a, b) => collator.compare(a.album ?? "", b.album ?? "") || compareTracks(a, b));
    const albumIds = new Set(tracks.map((t) => t.albumId).filter(Boolean));
    return {
      artist: artistInfo(artist),
      albums: [...albums.values()]
        .filter((a) => albumIds.has(a.id))
        .sort((a, b) => (a.year ?? 0) - (b.year ?? 0) || collator.compare(a.title, b.title))
        .map(albumInfo),
      tracks: tracks.map(trackInfo),
    };
  }

  /** The cached art file for an album, if it has any. */
  albumArt(id: string): { file: string; mime: string } | undefined {
    const art = this.art.get(id);
    return art?.file && art.mime ? { file: path.join(this.artDir, art.file), mime: art.mime } : undefined;
  }

  // ---- Scanning ----

  private async runScan(): Promise<ScanResult> {
    const started = Date.now();
    const result: ScanResult = { added: 0, updated: 0, removed: 0, unchanged: 0, unplayable: 0, unreadable: 0, ms: 0 };
    const seen = new Set<string>();
    const pending = new Set<Promise<void>>();

    for await (const file of this.source.list()) {
      const id = hash(file.path);
      seen.add(id);
      const existing = this.tracks.get(id);
      if (existing && existing.size === file.size && existing.version === file.version) {
        result.unchanged++;
        continue;
      }
      const skipped = this.skipped.get(id);
      if (skipped && skipped.size === file.size && skipped.version === file.version) {
        result[skipped.reason]++;
        continue;
      }
      const job: Promise<void> = this.indexFile(id, file, existing, result).finally(() => pending.delete(job));
      pending.add(job);
      if (pending.size >= this.concurrency) await Promise.race(pending);
    }
    await Promise.all(pending);

    for (const id of this.tracks.keys()) {
      if (!seen.has(id)) {
        this.tracks.delete(id);
        result.removed++;
        this.views = null;
      }
    }
    for (const id of this.skipped.keys()) if (!seen.has(id)) this.skipped.delete(id);

    await this.refreshArt();
    await this.save();
    result.ms = Date.now() - started;
    this.log?.info(
      `Library scan: ${this.tracks.size} tracks (${result.added} added, ${result.updated} updated, ` +
        `${result.removed} removed); skipped ${result.unplayable} unplayable and ${result.unreadable} unreadable ` +
        `files in ${(result.ms / 1000).toFixed(1)} s`,
    );
    return result;
  }

  private async indexFile(
    id: string,
    file: LibraryFile,
    existing: LibraryTrack | undefined,
    result: ScanResult,
  ): Promise<void> {
    let meta: IAudioMetadata;
    try {
      meta = await this.source.readMetadata(file, { covers: false });
    } catch {
      this.skip(id, file, "unreadable", result);
      return;
    }
    const verdict = classifyFormat(meta.format);
    if (!verdict.ok) {
      this.skip(id, file, "unplayable", result);
      return;
    }
    this.skipped.delete(id);
    const { common, format } = meta;
    const track: LibraryTrack = {
      id,
      path: file.path,
      size: file.size,
      version: file.version,
      mime: verdict.mime,
      title: clean(common.title) ?? titleFromFilename(file.path.slice(file.path.lastIndexOf("/") + 1)),
      artist: clean(joinedArtist(common)),
      albumArtist: clean(common.albumartist),
      album: clean(common.album),
      discNo: common.disk.no ?? undefined,
      trackNo: common.track.no ?? undefined,
      year: common.year ?? undefined,
      durationMs: format.duration && Number.isFinite(format.duration) ? Math.round(format.duration * 1000) : undefined,
    };
    this.tracks.set(id, track);
    this.views = null;
    if (existing) result.updated++;
    else result.added++;
  }

  private skip(id: string, file: LibraryFile, reason: SkippedFile["reason"], result: ScanResult): void {
    result[reason]++;
    this.skipped.set(id, { size: file.size, version: file.version, reason });
    if (this.tracks.delete(id)) this.views = null;
  }

  /** Extracts art for albums that are new or whose source changed; deletes art of vanished albums. */
  private async refreshArt(): Promise<void> {
    const { albums } = this.getViews();
    await fs.mkdir(this.artDir, { recursive: true });

    for (const album of albums.values()) {
      const first = album.tracks[0]!;
      const key = `${first.path}:${first.version}`;
      const cached = this.art.get(album.id);
      if (cached?.key === key && (!cached.file || (await exists(path.join(this.artDir, cached.file))))) continue;
      this.art.set(album.id, await this.extractArt(album, key));
    }
    for (const [albumId, art] of this.art) {
      if (albums.has(albumId)) continue;
      this.art.delete(albumId);
      if (art.file) await fs.rm(path.join(this.artDir, art.file), { force: true });
    }
    // Art presence is part of the album view.
    for (const album of albums.values()) album.hasArt = !!this.art.get(album.id)?.file;
  }

  private async extractArt(album: Album, key: string): Promise<AlbumArt> {
    const write = async (data: Uint8Array, mime: string): Promise<AlbumArt> => {
      const file = `${album.id}.${mime.split("/")[1]!.replace("jpeg", "jpg")}`;
      await fs.writeFile(path.join(this.artDir, file), data);
      return { key, file, mime };
    };
    // The first few tracks' embedded covers, then a folder image.
    for (const track of album.tracks.slice(0, 3)) {
      try {
        const meta = await this.source.readMetadata(track, { covers: true });
        const cover = selectCover(meta.common.picture);
        const mime = cover && imageMime(cover.format);
        if (cover && mime) return await write(cover.data, mime);
      } catch {
        // Try the next track.
      }
    }
    try {
      const folder = await this.source.folderArt(album.tracks[0]!.path);
      if (folder) return await write(await folder.read(), folder.mime);
    } catch {
      // No usable folder image.
    }
    return { key, file: null };
  }

  private async save(): Promise<void> {
    const cache: CacheFile = {
      version: 1,
      tracks: [...this.tracks.values()],
      skipped: Object.fromEntries(this.skipped),
      art: Object.fromEntries(this.art),
    };
    await fs.mkdir(path.dirname(this.cacheFile), { recursive: true });
    const tmp = `${this.cacheFile}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(cache));
    await fs.rename(tmp, this.cacheFile);
  }

  // ---- Views ----

  private getViews() {
    this.views ??= this.buildViews();
    return this.views;
  }

  private buildViews() {
    const trackFields = new Map<string, IndexedField[]>();
    const grouped = new Map<string, { title: string; dir: string; tracks: LibraryTrack[] }>();

    for (const track of this.tracks.values()) {
      trackFields.set(
        track.id,
        indexFields([
          { text: track.title, weight: 3 },
          { text: track.artist ?? "", weight: 2 },
          { text: track.albumArtist ?? "", weight: 2 },
          { text: track.album ?? "", weight: 1 },
        ]),
      );
      track.albumId = undefined;
      if (!track.album) continue;
      // Albums are one title within one folder, so two "Greatest Hits" stay apart.
      const dir = albumDir(track.path);
      const id = hash(`${normalize(track.album)}\0${dir}`);
      track.albumId = id;
      let group = grouped.get(id);
      if (!group) grouped.set(id, (group = { title: track.album, dir, tracks: [] }));
      group.tracks.push(track);
    }

    const albums = new Map<string, Album>();
    for (const [id, group] of grouped) {
      const tracks = group.tracks.sort(compareTracks);
      const artist = albumArtistOf(tracks);
      albums.set(id, {
        id,
        title: group.title,
        artist,
        year: tracks.find((t) => t.year)?.year,
        trackCount: tracks.length,
        durationMs: tracks.reduce((sum, t) => sum + (t.durationMs ?? 0), 0),
        hasArt: !!this.art.get(id)?.file,
        tracks,
        dir: group.dir,
        fields: indexFields([
          { text: group.title, weight: 3 },
          { text: artist ?? "", weight: 2 },
        ]),
      });
    }

    const artists = new Map<string, Artist>();
    const artistFor = (name: string) => {
      const key = normalize(name).trim();
      let artist = artists.get(key);
      if (!artist) {
        artist = { key, name, albumCount: 0, trackCount: 0, fields: indexFields([{ text: name, weight: 3 }]) };
        artists.set(key, artist);
      }
      return artist;
    };
    for (const track of this.tracks.values()) {
      const names = [track.artist, track.albumArtist].filter((n): n is string => !!n);
      const keys = new Set<string>();
      for (const name of names) {
        const artist = artistFor(name);
        if (!keys.has(artist.key)) artist.trackCount++;
        keys.add(artist.key);
      }
    }
    for (const album of albums.values()) {
      if (album.artist && album.artist !== VARIOUS_ARTISTS) artistFor(album.artist).albumCount++;
    }

    return { albums, artists, trackFields };
  }
}

/** The album's artist: its album artist tag, the one artist on every track, or "Various Artists". */
function albumArtistOf(tracks: LibraryTrack[]): string | undefined {
  const tagged = tracks.find((t) => t.albumArtist)?.albumArtist;
  if (tagged) return tagged;
  const artists = new Set(tracks.map((t) => t.artist).filter(Boolean));
  if (artists.size === 1) return [...artists][0];
  return artists.size > 1 ? VARIOUS_ARTISTS : undefined;
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}
