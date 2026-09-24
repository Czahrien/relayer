import { describe, expect, it } from "vitest";
import { albumFromFolder, isDiscFolder, splitDisc } from "./tags.js";

describe("splitDisc", () => {
  it.each([
    ["Moonmadness - CD 1", { title: "Moonmadness", disc: 1 }],
    ["Workshop Of The Telescopes CD 2", { title: "Workshop Of The Telescopes", disc: 2 }],
    ["The Anthology, CD3", { title: "The Anthology", disc: 3 }],
    ["Stars Die - The Delerium Years '91-'97 (Disc 2)", { title: "Stars Die - The Delerium Years '91-'97", disc: 2 }],
    ["Live In January '73 (disc 1)", { title: "Live In January '73", disc: 1 }],
    ["666 - CD 2", { title: "666", disc: 2 }],
    ["Anthology Disc 2", { title: "Anthology", disc: 2 }],
    ["Greatest Hits [CD1]", { title: "Greatest Hits", disc: 1 }],
    // Not disc markers.
    ["CD 1", { title: "CD 1" }],
    ["Disco 2000", { title: "Disco 2000" }],
    ["ABCD 1", { title: "ABCD 1" }],
    ["The Most Beautiful Dream - CD 1 - Nadzieje", { title: "The Most Beautiful Dream - CD 1 - Nadzieje" }],
    ["Abbey Road", { title: "Abbey Road" }],
  ])("%s", (album, expected) => {
    expect(splitDisc(album)).toEqual(expected);
  });
});

describe("isDiscFolder", () => {
  it.each([
    ["CD2", true],
    ["Disc 1", true],
    ["disk3", true],
    ["666 - CD 2", true],
    ["(1976) Moonmadness [MP3 320kbps]", false],
    ["Discography", false],
  ])("%s → %s", (name, expected) => {
    expect(isDiscFolder(name)).toBe(expected);
  });
});

describe("albumFromFolder", () => {
  it.each([
    ["Blue Phantom/(1971) Distortions [MP3 192kbps]/01 - diodo.mp3", "Blue Phantom", "Distortions"],
    ["Uriah Heep/Uriah Heep - Demons And Wizards (1972) [FLAC] {1996 Castle Remaster}/x.flac", "Uriah Heep", "Demons And Wizards"],
    ["Blue Öyster Cult/1995 - Workshop Of The Telescopes/x.mp3", "Blue Öyster Cult", "Workshop Of The Telescopes"],
    ["Band/[2001] Record/CD2/x.mp3", "Band", "Record"],
    ["Beyonce/B'Day/x.mp3", "Beyoncé", "B'Day"],
    // No artist tag: the parent folder's name is stripped instead.
    [
      "Uriah Heep/Uriah Heep - Conquest (1980) [flac] (2003 Expanded DeLuxe Edition)/x.flac",
      undefined,
      "Conquest (1980) (2003 Expanded DeLuxe Edition)",
    ],
    ["Loose/x.mp3", undefined, undefined],
    // Not albums.
    ["Blizaro/Unknown Album/x.mp3", "Blizaro", undefined],
    ["Beyoncé/x.mp3", "Beyonce", undefined],
    ["x.mp3", "Someone", undefined],
    ["Artist/[FLAC]/x.flac", "Artist", undefined],
  ])("%s", (trackPath, artist, expected) => {
    expect(albumFromFolder(trackPath, artist)).toBe(expected);
  });
});
