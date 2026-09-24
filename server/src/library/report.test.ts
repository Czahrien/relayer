import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { taggedWav, TINY_PNG, type FixtureTags } from "../fixtures.js";
import { libraryReport } from "./report.js";

let base: string;
let root: string;

async function put(rel: string, content: Buffer | string): Promise<void> {
  const file = path.join(root, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}
const wav = (tags: FixtureTags) => taggedWav(tags);

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), "lr-report-"));
  root = path.join(base, "music");
  const cover = { mime: "image/png", data: TINY_PNG };
  // A clean album, for contrast.
  await put("Good/Album/01.wav", wav({ title: "One", artist: "Good", album: "Album", track: "1", cover }));
  // Two copies of a song in one album.
  await put("Dup/Toxicity/01 - Prison Song.wav", wav({ title: "Prison Song", artist: "Dup", album: "Toxicity", track: "1" }));
  await put("Dup/Toxicity/01 Prison Song.wav", wav({ title: "Prison Song", artist: "Dup", album: "Toxicity", track: "1" }));
  // An album tag typo.
  await put("Sab/Born Again/01.wav", wav({ title: "A", artist: "Sab", album: "Born Again", track: "1" }));
  await put("Sab/Born Again/02.wav", wav({ title: "B", artist: "Sab", album: "Borna Again", track: "2" }));
  // No tags at all, and an image that isn't the front.
  await put("Uriah Heep/Uriah Heep - Conquest (1980) [flac]/01 - Carry On.wav", wav({}));
  await put("Uriah Heep/Uriah Heep - Conquest (1980) [flac]/artwork/back.jpg", TINY_PNG);
  // Artist spellings, and a format the app can't play.
  await put("K/Nihil/01.wav", wav({ title: "Juke Joint", artist: "KMFDM", album: "Nihil", track: "1" }));
  await put("K/Nihil/02.wav", wav({ title: "Ultra", artist: "Kmfdm", album: "Nihil", track: "2" }));
  await put("Q/Era Vulgaris/01 Misfit Love.wma", "not really wma");
});

afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

it("reports each kind of problem, and only reads the library", async () => {
  const before = await snapshot(root);
  const report = await libraryReport(root, { dataDir: path.join(base, "data") });

  expect(report).toMatch(/\| Audio files indexed \| 8 \|/);
  expect(report).toMatch(/^## 1\. Files the app can't play$/m);
  expect(report).toContain("`01 Misfit Love.wma`");
  expect(report).toMatch(/\*\*Dup — Toxicity\*\*.*1 duplicated track, e\.g\. `01 - Prison Song\.wav` and `01 Prison Song\.wav`/);
  expect(report).toMatch(/"Borna Again" \(Sab\), 1 track: `02\.wav`/);
  // The untagged file: missing album, title, and artist tags, with the album the app infers.
  expect(report).toMatch(/Uriah Heep - Conquest \(1980\) \[flac\]`: 1 file, shown as "Conquest"/);
  // Sections are numbered only when present.
  expect(report).toMatch(/^## \d+\. Files without a title tag$/m);
  expect(report).toMatch(/^## \d+\. Files without an artist tag$/m);
  expect(report).not.toContain("Box sets with a name per disc");
  expect(report).toContain('"KMFDM" vs "Kmfdm"');
  // Art: the clean album has it; the Uriah Heep folder only has a back cover.
  expect(report).toMatch(/\| Albums with art \| 1 \(\d+%\) \|/);
  expect(report).toMatch(/\*\*unknown artist — Conquest\*\*.*`artwork\/back\.jpg`/);

  expect(await snapshot(root)).toEqual(before);
});

it("leaves out sections with nothing to report", async () => {
  await fs.rm(root, { recursive: true });
  await put("Good/Album/01.wav", wav({ title: "One", artist: "Good", album: "Album", track: "1", cover: { mime: "image/png", data: TINY_PNG } }));
  const report = await libraryReport(root, { dataDir: path.join(base, "data") });
  expect(report).not.toMatch(/^## \d/m);
  expect(report).toMatch(/\| Albums with art \| 1 \(100%\) \|/);
});

/** Every file's path, size, and mtime, to check nothing was written. */
async function snapshot(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath, entry.name);
    const stat = await fs.stat(full);
    out.push(`${path.relative(dir, full)} ${stat.size} ${stat.mtimeMs}`);
  }
  return out.sort();
}
