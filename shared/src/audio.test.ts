import { describe, expect, it } from "vitest";
import { isAudioName, joinedArtist, parseFilename } from "./audio.js";

describe("parseFilename", () => {
  it.each([
    ["01 - diodo.mp3", { title: "diodo", trackNo: 1 }],
    ["05 - equilibrium.mp3", { title: "equilibrium", trackNo: 5 }],
    ["01. Intro.flac", { title: "Intro", trackNo: 1 }],
    ["3) Third.ogg", { title: "Third", trackNo: 3 }],
    ["03_Sorry.wav", { title: "Sorry", trackNo: 3 }],
    ["01 Prison Song.m4a", { title: "Prison Song", trackNo: 1 }],
    ["1-04 Song.m4a", { title: "Song", trackNo: 4 }],
    ["112 - Long Album Track.mp3", { title: "Long Album Track", trackNo: 112 }],
    // Numbers that are part of the title stay.
    ["99 Luftballons.mp3", { title: "99 Luftballons" }],
    ["2112.mp3", { title: "2112" }],
    ["1.5 Degrees.mp3", { title: "1.5 Degrees" }],
    ["Ecailles De Lune (Part II).mp3", { title: "Ecailles De Lune (Part II)" }],
    ["01 - .mp3", { title: "01 -" }],
  ])("%s", (name, expected) => {
    expect(parseFilename(name)).toEqual(expected);
  });
});

describe("joinedArtist", () => {
  it("rejoins artists split on slashes", () => {
    expect(joinedArtist({ artist: "AC", artists: ["AC", "DC"] })).toBe("AC/DC");
    expect(joinedArtist({ artist: "Solo" })).toBe("Solo");
    expect(joinedArtist({})).toBeUndefined();
  });
});

it("recognizes audio names", () => {
  expect(isAudioName("x.FLAC")).toBe(true);
  expect(isAudioName("cover.jpg")).toBe(false);
});
