import fs from "node:fs/promises";
import path from "node:path";
import { Library, type LibraryAlbum, type LibraryLogger, type LibraryTrack } from "./library.js";
import { LocalDirSource } from "./source.js";

/** Formats the app can't play, which the library skips by extension. */
const UNPLAYABLE = /\.(ape|wma|aiff?|wv|mpc|dsf|dff|tta|shn)$/i;
const IMAGE = /\.(jpe?g|png|webp|gif|bmp|tiff?)$/i;

export interface ReportOptions {
  /** Where the report's own index cache goes (use a temporary folder). */
  dataDir: string;
  log?: LibraryLogger;
}

/** What each file's tags actually say, before the app fills anything in. */
interface RawTags {
  path: string;
  title?: string;
  artist?: string;
  album?: string;
}

/**
 * A Markdown report of problems in a music library that the app works around
 * but that are better fixed in the files: unplayable formats, duplicates,
 * album tag typos, missing tags, artist spelling variants, and missing art.
 * Only reads the library.
 */
export async function libraryReport(root: string, { dataDir, log }: ReportOptions): Promise<string> {
  const started = Date.now();
  const source = new LocalDirSource(root);
  const library = new Library({ source, dataDir, log });
  log?.info("Scanning the library…");
  await library.scan();
  const tracks = library.listTracks();
  const albums = library.listAlbums();
  const trackByPath = new Map(tracks.map((t) => [t.path, t]));

  log?.info("Reading tags…");
  const raw: RawTags[] = [];
  const files = [];
  for await (const file of source.list()) files.push(file);
  for (let i = 0; i < files.length; i += 8) {
    await Promise.all(
      files.slice(i, i + 8).map(async (file) => {
        try {
          const { common } = await source.readMetadata(file, { covers: false });
          raw.push({
            path: file.path,
            title: common.title?.trim() || undefined,
            artist: (common.artist ?? common.albumartist)?.trim() || undefined,
            album: common.album?.trim() || undefined,
          });
        } catch {
          // Unreadable: the scan already left it out.
        }
      }),
    );
  }
  raw.sort((a, b) => a.path.localeCompare(b.path));
  const unplayable = (await listFiles(root)).filter((p) => UNPLAYABLE.test(p)).sort();

  // ---- Find the issues ----

  const noAlbumTag = raw.filter((r) => !r.album).map((r) => ({ ...r, shownAs: trackByPath.get(r.path)?.album }));
  const noTitleTag = raw.filter((r) => !r.title);
  const noArtistTag = raw.filter((r) => !r.artist);
  const noTrackNumber = tracks.filter((t) => t.album && t.trackNo === undefined);

  const duplicates = albums
    .map((album) => {
      const seen = new Map<string, LibraryTrack[]>();
      for (const t of album.tracks) push(seen, `${t.discNo ?? 1}|${t.trackNo ?? ""}|${t.title.toLowerCase()}`, t);
      return { album, copies: [...seen.values()].filter((list) => list.length > 1) };
    })
    .filter((x) => x.copies.length > 0);

  // Folders whose own tracks split into several albums (not artist folders holding disc sets).
  const albumsByDir = new Map<string, LibraryAlbum[]>();
  for (const a of albums) push(albumsByDir, a.dir, a);
  const splitFolders = [...albumsByDir]
    .filter(([d, list]) => list.length > 1 && list.some((a) => a.tracks.some((t) => dirOf(t.path) === d)))
    .sort((a, b) => a[0].localeCompare(b[0]));

  const byTitle = new Map<string, LibraryAlbum[]>();
  for (const a of albums) push(byTitle, `${loose(a.artist ?? "")}|${loose(a.title)}`, a);
  const inSeveralFolders = [...byTitle.values()].filter((list) => list.length > 1);

  const spellings = new Map<string, Set<string>>();
  for (const name of new Set(tracks.flatMap((t) => [t.artist, t.albumArtist]).filter((n): n is string => !!n))) {
    const key = loose(name.replace(/\s+(feat\.?|ft\.?|featuring)\s.*$/i, ""));
    spellings.set(key, new Set([...(spellings.get(key) ?? []), name]));
  }
  const artistVariants = [...spellings.values()].filter((s) => s.size > 1).map((s) => [...s].sort());

  const namedDiscs = albums
    .filter((a) => /\b(cd|disc|disk)\s*\d+\s*[-–:]\s*\S/i.test(a.title))
    .sort((a, b) => a.title.localeCompare(b.title));
  const noArt = albums.filter((a) => !a.hasArt).sort((a, b) => `${who(a)}${a.title}`.localeCompare(`${who(b)}${b.title}`));
  const unusedArt: { album: LibraryAlbum; images: string[] }[] = [];
  for (const album of noArt) {
    const images = await imagesNear(root, album);
    if (images.length > 0) unusedArt.push({ album, images });
  }

  // ---- Write it up ----

  const md: string[] = [];
  const item = (text: string) => md.push(`- ${text}`);
  let number = 0;
  const section = (title: string, intro: string, items: unknown[], body: () => void) => {
    if (items.length === 0) return;
    md.push("", `## ${++number}. ${title}`, "", intro, "");
    body();
  };
  const withArt = albums.filter((a) => a.hasArt).length;

  md.push(
    "# Music library notes",
    "",
    `From a scan of ${code(root)} by Listening Room on ${new Date().toISOString().slice(0, 10)}. The app works around most of these, but fixing them in the files helps every player. A tagger such as MusicBrainz Picard or beets can fix most tag problems in bulk.`,
    "",
    "## Summary",
    "",
    "| | Count |",
    "|---|---|",
  );
  for (const [label, value] of [
    ["Audio files indexed", tracks.length],
    ["Albums", albums.length],
    ["Albums with art", `${withArt} (${albums.length ? Math.round((100 * withArt) / albums.length) : 0}%)`],
    ["Files the app can't play", unplayable.length],
    ["Albums with duplicate copies of tracks", duplicates.length],
    ["Folders split into several albums by their tags", splitFolders.length],
    ["Albums in more than one folder", inSeveralFolders.length],
    ["Files without an album tag", noAlbumTag.length],
    ["Files without a title tag", noTitleTag.length],
    ["Files without an artist tag", noArtistTag.length],
    ["Album tracks without a track number", noTrackNumber.length],
    ["Artists with several spellings", artistVariants.length],
  ] as const) {
    md.push(`| ${label} | ${value} |`);
  }

  section(
    "Files the app can't play",
    "Browsers can't decode these formats, so the library skips them. Convert them (APE to FLAC is lossless; WMA to MP3 or AAC), or remove them. Whole-disc images (such as `CDImage.ape`) also need splitting into tracks with their `.cue` sheets.",
    unplayable,
    () => {
      for (const [d, list] of byFolder(unplayable.map((p) => ({ path: p })))) {
        item(`${code(d || ".")}: ${list.map((x) => code(baseOf(x.path))).join(", ")}`);
      }
    },
  );

  section(
    "Duplicate copies of tracks",
    "The same disc, track number, and title appears more than once in one album, so the album plays those songs twice. Keep one copy of each.",
    duplicates,
    () => {
      for (const { album, copies } of duplicates) {
        const examples = copies
          .slice(0, 2)
          .map((list) => list.map((t) => code(baseOf(t.path))).join(" and "))
          .join("; ");
        item(`**${who(album)} — ${album.title}** (${code(album.dir)}): ${count(copies.length, "duplicated track")}, e.g. ${examples}`);
      }
    },
  );

  section(
    "Folders split into several albums",
    "Tracks in one folder carry different album tags, so they show up as separate albums: a typo in the album tag, or a stray file.",
    splitFolders,
    () => {
      for (const [d, list] of splitFolders) {
        item(code(d));
        for (const a of [...list].sort((x, y) => x.trackCount - y.trackCount)) {
          const files = a.trackCount <= 3 ? `: ${a.tracks.map((t) => code(baseOf(t.path))).join(", ")}` : "";
          md.push(`  - "${a.title}" (${who(a)}), ${count(a.trackCount, "track")}${files}`);
        }
      }
    },
  );

  section(
    "The same album in several folders",
    "One artist and album title in more than one folder. Often intentional (an MP3 and a FLAC copy, or a remaster), sometimes a mistag. They're kept as separate albums.",
    inSeveralFolders,
    () => {
      for (const list of inSeveralFolders) item(`**${who(list[0]!)} — ${list[0]!.title}**: ${list.map((a) => code(a.dir)).join(", ")}`);
    },
  );

  section(
    "Box sets with a name per disc",
    'Album tags like "… - CD 3 - Supernova" name each disc, so the discs stay separate albums. To join them, give every disc the set\'s album name and set the disc numbers.',
    namedDiscs,
    () => {
      for (const a of namedDiscs) item(`${who(a)} — "${a.title}" (${code(a.dir)})`);
    },
  );

  section(
    "Files without an album tag",
    "The app names these albums after their folder. Real tags give better names, plus album artists, years, and art.",
    noAlbumTag,
    () => {
      for (const [d, list] of byFolder(noAlbumTag)) {
        const names = [...new Set(list.map((x) => x.shownAs ?? ""))].map((n) => (n ? `"${n}"` : "**no album**"));
        item(`${code(d || ".")}: ${count(list.length, "file")}, shown as ${names.join(", ")}`);
      }
    },
  );

  section("Files without a title tag", "Titles come from the filename, with any leading track number removed.", noTitleTag, () => {
    for (const [d, list] of byFolder(noTitleTag)) item(`${code(d || ".")}: ${count(list.length, "file")}`);
  });

  section(
    "Files without an artist tag",
    "These don't appear under any artist in search, and their albums have no artist.",
    noArtistTag,
    () => {
      for (const [d, list] of byFolder(noArtistTag)) item(`${code(d || ".")}: ${count(list.length, "file")}`);
    },
  );

  section(
    "Album tracks without a track number",
    "No track tag and no number in the filename, so these play in filename order within their album.",
    noTrackNumber,
    () => {
      for (const [d, list] of byFolder(noTrackNumber)) item(`${code(d || ".")}: ${count(list.length, "file")} (album "${list[0]!.album}")`);
    },
  );

  section(
    "Artists with several spellings",
    'These differ only in capitals, accents, punctuation, "&" vs "and", a leading "The", or a "feat." credit. The app already merges spellings that differ only in capitals or accents (shown under whichever spelling it finds first); the others appear as separate artists. Either way, picking one spelling tidies them up.',
    artistVariants,
    () => {
      for (const names of artistVariants) item(names.map((n) => `"${n}"`).join(" vs "));
    },
  );

  section(
    "Albums without art",
    `${noArt.length} albums have no embedded cover and no usable folder image. For ${unusedArt.length} of them, the album's folder does hold images, but none the app could tell was the front cover (they're backs, booklets, thumbnails, or unnamed). Renaming the front to ${code("cover.jpg")}, or embedding it, fixes those:`,
    noArt,
    () => {
      for (const { album, images } of unusedArt) {
        const more = images.length > 4 ? `, and ${images.length - 4} more` : "";
        item(`**${who(album)} — ${album.title}** (${code(album.dir)}): ${images.slice(0, 4).map(code).join(", ")}${more}`);
      }
      const rest = noArt.filter((a) => !unusedArt.some((u) => u.album === a));
      if (rest.length > 0) {
        md.push("", `<details><summary>The other ${rest.length} albums, with no images at all</summary>`, "");
        for (const a of rest) item(`${who(a)} — ${a.title} (${code(a.dir)})`);
        md.push("", "</details>");
      }
    },
  );

  md.push("", "---", "", `Scan and report took ${Math.round((Date.now() - started) / 1000)} s.`);
  return md.join("\n") + "\n";
}

// ---- Helpers ----

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

const dirOf = (p: string) => p.split("/").slice(0, -1).join("/");
const baseOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const who = (album: LibraryAlbum) => album.artist ?? "unknown artist";
const code = (text: string) => `\`${text.replace(/`/g, "'")}\``;
const count = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

/** Case, accents, punctuation, "&", and a leading "The" ignored. */
function loose(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/^the\s+/, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function byFolder<T extends { path: string }>(list: T[]): [string, T[]][] {
  const folders = new Map<string, T[]>();
  for (const x of list) push(folders, dirOf(x.path), x);
  return [...folders].sort((a, b) => a[0].localeCompare(b[0]));
}

/** Every file under root, relative, without following symlinks or entering hidden folders. */
async function listFiles(root: string, rel = ""): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(path.join(root, rel), { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const child = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) files.push(...(await listFiles(root, child)));
    else if (e.isFile()) files.push(child);
  }
  return files;
}

/** Images where the app looks for art: the album's own folders and their immediate subfolders. */
async function imagesNear(root: string, album: LibraryAlbum): Promise<string[]> {
  const found: string[] = [];
  for (const d of new Set(album.tracks.map((t) => dirOf(t.path)))) {
    let entries;
    try {
      entries = await fs.readdir(path.join(root, d), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isFile() && IMAGE.test(e.name)) found.push(e.name);
      else if (e.isDirectory() && !e.name.startsWith(".")) {
        const inner = await fs.readdir(path.join(root, d, e.name)).catch(() => [] as string[]);
        for (const f of inner) if (IMAGE.test(f)) found.push(`${e.name}/${f}`);
      }
    }
  }
  return found.sort();
}
