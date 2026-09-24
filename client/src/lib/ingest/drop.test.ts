import { describe, expect, it } from "vitest";
import { compareBatch, extractLinks, isAudioName, titleFromFilename, type PreparedFile } from "./drop.js";

function f(path: string, tags: Partial<PreparedFile> = {}): PreparedFile {
  return { path, file: new File([], path.split("/").pop()!), title: path, ...tags };
}

const order = (files: PreparedFile[]) => [...files].sort(compareBatch).map((x) => x.path);

describe("compareBatch", () => {
  it("sorts by track number, not filename", () => {
    expect(
      order([
        f("Album/b.mp3", { trackNo: 1 }),
        f("Album/a.mp3", { trackNo: 3 }),
        f("Album/c.mp3", { trackNo: 2 }),
      ]),
    ).toEqual(["Album/b.mp3", "Album/c.mp3", "Album/a.mp3"]);
  });

  it("sorts by disc before track", () => {
    expect(
      order([
        f("Album/x.flac", { discNo: 2, trackNo: 1 }),
        f("Album/y.flac", { discNo: 1, trackNo: 2 }),
        f("Album/z.flac", { discNo: 1, trackNo: 1 }),
      ]),
    ).toEqual(["Album/z.flac", "Album/y.flac", "Album/x.flac"]);
  });

  it("keeps directories together, in natural order", () => {
    expect(
      order([
        f("Box/CD10/01.mp3", { trackNo: 1 }),
        f("Box/CD2/02.mp3", { trackNo: 2 }),
        f("Box/CD2/01.mp3", { trackNo: 1 }),
        f("Box/CD1/01.mp3", { trackNo: 1 }),
      ]),
    ).toEqual(["Box/CD1/01.mp3", "Box/CD2/01.mp3", "Box/CD2/02.mp3", "Box/CD10/01.mp3"]);
  });

  it("falls back to natural filename order, after tagged tracks", () => {
    expect(order([f("A/track 10.mp3"), f("A/track 9.mp3"), f("A/track 1.mp3"), f("A/zz.mp3", { trackNo: 4 })])).toEqual(
      ["A/zz.mp3", "A/track 1.mp3", "A/track 9.mp3", "A/track 10.mp3"],
    );
  });
});

describe("helpers", () => {
  it("recognizes audio extensions case-insensitively", () => {
    expect(isAudioName("Song.FLAC")).toBe(true);
    expect(isAudioName("x.opus")).toBe(true);
    expect(isAudioName("cover.jpg")).toBe(false);
    expect(isAudioName("rip.cue")).toBe(false);
    expect(isAudioName("noext")).toBe(false);
  });

  it("derives titles from filenames", () => {
    expect(titleFromFilename("01_Intro.mp3")).toBe("01 Intro");
    expect(titleFromFilename("song.name.flac")).toBe("song.name");
  });

  it("extracts links, preferring text/uri-list", () => {
    expect(extractLinks("# comment\nhttps://youtu.be/dQw4w9WgXcQ\n", "ignored")).toEqual([
      "https://youtu.be/dQw4w9WgXcQ",
    ]);
    expect(extractLinks("", "look at https://www.youtube.com/watch?v=dQw4w9WgXcQ please")).toEqual([
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    ]);
    expect(extractLinks("", "no links here")).toEqual([]);
  });
});
