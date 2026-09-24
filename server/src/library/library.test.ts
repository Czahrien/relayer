import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { taggedWav, TINY_PNG, type FixtureTags } from "../fixtures.js";
import { Library } from "./library.js";
import { LocalDirSource, type LibraryFile, type LibrarySource } from "./source.js";

let root: string;
let dataDir: string;
let outside: string;

async function put(rel: string, content: Buffer | string): Promise<void> {
  const file = path.join(root, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

const wav = (tags: FixtureTags, formatCode?: number) => taggedWav(tags, { formatCode });

/** Counts metadata reads, to check that rescans are incremental. */
class CountingSource implements LibrarySource {
  reads: string[] = [];
  coverReads: string[] = [];
  constructor(private readonly inner: LibrarySource) {}
  list() {
    return this.inner.list();
  }
  readMetadata(file: LibraryFile, options: { covers: boolean }) {
    (options.covers ? this.coverReads : this.reads).push(file.path);
    return this.inner.readMetadata(file, options);
  }
  stat(p: string) {
    return this.inner.stat(p);
  }
  open(p: string, range?: { start: number; end: number }) {
    return this.inner.open(p, range);
  }
  folderArt(p: string) {
    return this.inner.folderArt(p);
  }
}

function newLibrary() {
  const source = new CountingSource(new LocalDirSource(root));
  return { source, library: new Library({ source, dataDir }) };
}

beforeEach(async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "lr-library-"));
  root = path.join(base, "music");
  dataDir = path.join(base, "data");
  outside = path.join(base, "outside");
  await fs.mkdir(root);
  await fs.mkdir(outside);

  const cover = { mime: "image/png", data: TINY_PNG };
  await put("Beyoncé/B'Day/01 Déjà Vu.wav", wav({ title: "Déjà Vu", artist: "Beyoncé", album: "B'Day", track: "1", year: "2006", cover }));
  await put("Beyoncé/B'Day/02 Irreplaceable.wav", wav({ title: "Irreplaceable", artist: "Beyoncé", album: "B'Day", track: "2" }));
  await put("Beyoncé/B'Day/notes.txt", "not audio");
  // A two-disc album split into subfolders.
  await put("Band/Double/CD2/01 Side C.wav", wav({ title: "Side C", artist: "Band", album: "Double", disc: "2", track: "1" }));
  await put("Band/Double/CD1/02 Side B.wav", wav({ title: "Side B", artist: "Band", album: "Double", disc: "1", track: "2" }));
  await put("Band/Double/CD1/01 Side A.wav", wav({ title: "Side A", artist: "Band", album: "Double", disc: "1", track: "1" }));
  // A compilation without an album artist tag.
  await put("Comp/Mix/01.wav", wav({ title: "One", artist: "Artist X", album: "Mix", track: "1" }));
  await put("Comp/Mix/02.wav", wav({ title: "Two", artist: "Artist Y", album: "Mix", track: "2" }));
  // Same album title in two folders: two albums.
  await put("P/Greatest Hits/01.wav", wav({ title: "P Hit", artist: "P", album: "Greatest Hits" }));
  await put("Q/Greatest Hits/01.wav", wav({ title: "Q Hit", artist: "Q", album: "Greatest Hits" }));
  // Art from a folder image instead of an embedded cover.
  await put("Folder/Art Album/01.wav", wav({ title: "Framed", artist: "Painter", album: "Art Album" }));
  await put("Folder/Art Album/cover.png", TINY_PNG);
  // Untagged, unplayable, junk, and hidden files.
  await put("Loose/untagged_song.wav", wav({}));
  await put("Loose/adpcm.wav", wav({ title: "Unplayable" }, 2));
  await put("Loose/junk.mp3", "this is not an mp3 file at all ".repeat(40));
  await put(".hidden/secret.wav", wav({ title: "Hidden" }));
  // Symlinks escaping the root, and a duplicate link inside it.
  await fs.writeFile(path.join(outside, "escape.wav"), wav({ title: "Escaped" }));
  await fs.symlink(outside, path.join(root, "OutsideDir"));
  await fs.symlink(path.join(outside, "escape.wav"), path.join(root, "escape-link.wav"));
  await fs.symlink(path.join(root, "Loose/untagged_song.wav"), path.join(root, "duplicate-link.wav"));
});

afterEach(async () => {
  await fs.rm(path.dirname(root), { recursive: true, force: true });
});

const titles = (library: Library, q: string) => library.search(q).tracks.map((t) => t.title);

describe("Library scanning", () => {
  it("indexes playable audio and skips everything else", async () => {
    const { library } = newLibrary();
    const result = await library.scan();
    expect(library.trackCount).toBe(11);
    // adpcm.wav is unplayable; junk.mp3 is either unreadable or has no playable codec.
    expect(result.added).toBe(11);
    expect(result.unplayable + result.unreadable).toBe(2);
    expect(titles(library, "escaped")).toEqual([]);
    expect(titles(library, "hidden")).toEqual([]);
    expect(titles(library, "unplayable")).toEqual([]);
  });

  it("reads tags, with filename fallbacks and no paths in results", async () => {
    const { library } = newLibrary();
    await library.scan();
    const [song] = library.search("deja vu").tracks;
    expect(song).toMatchObject({ title: "Déjà Vu", artist: "Beyoncé", album: "B'Day", trackNo: 1, year: 2006 });
    expect(song!.durationMs).toBeCloseTo(1000, -1);
    expect(song).not.toHaveProperty("path");
    expect(titles(library, "untagged")).toEqual(["untagged song"]);
    // The server-side record does keep the path and the served type.
    expect(library.track(song!.id)).toMatchObject({ path: "Beyoncé/B'Day/01 Déjà Vu.wav", mime: "audio/wav" });
  });

  it("groups albums by title and folder, merging multi-disc subfolders", async () => {
    const { library } = newLibrary();
    await library.scan();
    const albums = library.search("double").albums;
    expect(albums).toHaveLength(1);
    const double = library.album(albums[0]!.id)!;
    expect(double.album).toMatchObject({ title: "Double", artist: "Band", trackCount: 3 });
    expect(double.tracks.map((t) => t.title)).toEqual(["Side A", "Side B", "Side C"]);
    expect(library.albumTrackIds(albums[0]!.id)).toEqual(double.tracks.map((t) => t.id));

    expect(library.search("greatest hits").albums.map((a) => a.artist).sort()).toEqual(["P", "Q"]);
    expect(library.search("mix").albums[0]).toMatchObject({ artist: "Various Artists", trackCount: 2 });
  });

  it("extracts album art from embedded covers or folder images", async () => {
    const { library } = newLibrary();
    await library.scan();
    const bday = library.search("b'day").albums[0]!;
    const framed = library.search("art album").albums[0]!;
    const double = library.search("double").albums[0]!;
    expect(bday.hasArt).toBe(true);
    expect(framed.hasArt).toBe(true);
    expect(double.hasArt).toBe(false);
    const art = library.albumArt(bday.id)!;
    expect(art.mime).toBe("image/png");
    expect((await fs.readFile(art.file)).equals(TINY_PNG)).toBe(true);
    expect(library.albumArt(double.id)).toBeUndefined();
  });

  it("lists an artist's albums and tracks", async () => {
    const { library } = newLibrary();
    await library.scan();
    expect(library.search("beyonce").artists).toEqual([{ name: "Beyoncé", albumCount: 1, trackCount: 2 }]);
    const artist = library.artist("BEYONCE")!;
    expect(artist.albums.map((a) => a.title)).toEqual(["B'Day"]);
    expect(artist.tracks.map((t) => t.title)).toEqual(["Déjà Vu", "Irreplaceable"]);
    expect(library.artist("nobody")).toBeUndefined();
  });
});

describe("Library rescans and cache", () => {
  it("re-reads only changed files, and drops removed ones", async () => {
    const { library, source } = newLibrary();
    await library.scan();
    source.reads = [];
    source.coverReads = [];

    const unchanged = await library.scan();
    expect(source.reads).toEqual([]);
    expect(source.coverReads).toEqual([]);
    expect(unchanged).toMatchObject({ added: 0, updated: 0, removed: 0, unchanged: 11 });
    // Skipped files are remembered, not re-read, but still counted.
    expect(unchanged.unplayable + unchanged.unreadable).toBe(2);

    // Retag one file (with a new mtime) and delete another.
    const file = path.join(root, "Beyoncé/B'Day/02 Irreplaceable.wav");
    await fs.writeFile(file, wav({ title: "Irreplaceable (Remix)", artist: "Beyoncé", album: "B'Day", track: "2" }));
    await fs.utimes(file, new Date(), new Date(Date.now() + 60_000));
    await fs.rm(path.join(root, "Comp/Mix/02.wav"));

    const changed = await library.scan();
    expect(source.reads).toEqual(["Beyoncé/B'Day/02 Irreplaceable.wav"]);
    expect(changed).toMatchObject({ updated: 1, removed: 1 });
    expect(titles(library, "irreplaceable")).toEqual(["Irreplaceable (Remix)"]);
    expect(titles(library, "two")).toEqual([]);
  });

  it("keeps IDs stable across restarts and serves the cache before scanning", async () => {
    const first = newLibrary();
    await first.library.scan();
    const id = first.library.search("deja").tracks[0]!.id;

    const second = newLibrary();
    await second.library.load();
    expect(second.library.search("deja").tracks[0]!.id).toBe(id);
    await second.library.scan();
    expect(second.source.reads).toEqual([]);
    expect(second.source.coverReads).toEqual([]);
    expect(second.library.search("b'day").albums[0]!.hasArt).toBe(true);
  });

  it("deletes art for albums that disappear", async () => {
    const { library } = newLibrary();
    await library.scan();
    const bday = library.search("b'day").albums[0]!;
    const art = library.albumArt(bday.id)!.file;
    await fs.rm(path.join(root, "Beyoncé"), { recursive: true });
    await library.scan();
    expect(library.albumArt(bday.id)).toBeUndefined();
    await expect(fs.access(art)).rejects.toThrow();
  });

  it("shares one scan between concurrent callers", async () => {
    const { library, source } = newLibrary();
    const [a, b] = await Promise.all([library.scan(), library.scan()]);
    expect(a).toBe(b);
    expect(source.reads).toHaveLength(new Set(source.reads).size);
  });
});

describe("LocalDirSource", () => {
  it("refuses paths that resolve outside the root", async () => {
    const source = new LocalDirSource(root);
    await expect(source.open("escape-link.wav")).rejects.toThrow(/outside the library/);
    await expect(source.open("../outside/escape.wav")).rejects.toThrow(/outside the library/);
    expect(await source.stat("OutsideDir/escape.wav")).toBeNull();
  });

  it("ignores folder images that link outside the root", async () => {
    await fs.writeFile(path.join(outside, "secret.png"), TINY_PNG);
    await put("Linked/Album/01.wav", wav({ title: "L", album: "Linked" }));
    await fs.symlink(path.join(outside, "secret.png"), path.join(root, "Linked/Album/cover.png"));
    const source = new LocalDirSource(root);
    expect(await source.folderArt("Linked/Album/01.wav")).toBeNull();
    expect(await source.folderArt("Folder/Art Album/01.wav")).toMatchObject({ mime: "image/png" });
  });

  it("serves byte ranges and reports size", async () => {
    const source = new LocalDirSource(root);
    const stat = await source.stat("Loose/untagged_song.wav");
    expect(stat?.size).toBeGreaterThan(44);
    const stream = await source.open("Loose/untagged_song.wav", { start: 0, end: 3 });
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString("latin1")).toBe("RIFF");
  });
});
