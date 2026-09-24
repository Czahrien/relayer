import { describe, expect, it } from "vitest";
import { indexFields, normalize, parseQuery, rank, score, words } from "./search.js";

describe("normalize and words", () => {
  it("folds case and accents", () => {
    expect(normalize("Beyoncé")).toBe("beyonce");
    expect(normalize("MOTÖRHEAD")).toBe("motorhead");
    expect(normalize("Sigur Rós")).toBe("sigur ros");
  });

  it("splits on punctuation and keeps numbers", () => {
    expect(words("AC/DC — Back in Black (2003 Remaster)")).toEqual(["ac", "dc", "back", "in", "black", "2003", "remaster"]);
    expect(words("  ")).toEqual([]);
  });

  it("joins apostrophes instead of splitting on them", () => {
    expect(words("Don't Stop Me Now")).toEqual(["dont", "stop", "me", "now"]);
    expect(words("B’Day")).toEqual(["bday"]);
  });

  it("ignores empty queries", () => {
    expect(parseQuery("  !! ")).toBeNull();
  });
});

describe("score", () => {
  const song = indexFields([
    { text: "Here Comes the Sun", weight: 3 },
    { text: "The Beatles", weight: 2 },
    { text: "Abbey Road", weight: 1 },
  ]);

  it("requires every query word to prefix-match some field", () => {
    expect(score(parseQuery("here sun")!, song)).toBeGreaterThan(0);
    expect(score(parseQuery("beat abb")!, song)).toBeGreaterThan(0);
    expect(score(parseQuery("here moon")!, song)).toBe(0);
    // Prefixes only: a word in the middle doesn't match.
    expect(score(parseQuery("eatles")!, song)).toBe(0);
  });

  it("matches punctuation-free spellings", () => {
    const fields = indexFields([{ text: "AC/DC", weight: 2 }]);
    expect(score(parseQuery("acdc")!, fields)).toBeGreaterThan(0);
    expect(score(parseQuery("ac dc")!, fields)).toBeGreaterThan(0);
    const bday = indexFields([{ text: "B'Day", weight: 3 }]);
    expect(score(parseQuery("bday")!, bday)).toBeGreaterThan(0);
    expect(score(parseQuery("b'day")!, bday)).toBeGreaterThan(0);
  });

  it("matches across accents", () => {
    const fields = indexFields([{ text: "Beyoncé", weight: 2 }]);
    expect(score(parseQuery("beyonce")!, fields)).toBeGreaterThan(0);
    expect(score(parseQuery("BEYONCÉ")!, fields)).toBeGreaterThan(0);
  });

  it("ranks whole words over prefixes and heavy fields over light ones", () => {
    const exact = score(parseQuery("sun")!, song);
    const prefix = score(parseQuery("su")!, song);
    expect(exact).toBeGreaterThan(prefix);

    const inTitle = score(parseQuery("road")!, indexFields([{ text: "Road", weight: 3 }]));
    const inAlbum = score(parseQuery("road")!, indexFields([{ text: "Road", weight: 1 }]));
    expect(inTitle).toBeGreaterThan(inAlbum);
  });

  it("ranks a whole-word match over a field that merely starts with the query", () => {
    const whole = score(parseQuery("love")!, indexFields([{ text: "All You Need Is Love", weight: 3 }]));
    const starts = score(parseQuery("love")!, indexFields([{ text: "Lovely Day", weight: 3 }]));
    expect(whole).toBeGreaterThan(starts);
  });

  it("gives a field matching the whole query a bonus", () => {
    const album = indexFields([{ text: "Abbey Road", weight: 3 }]);
    const mention = indexFields([
      { text: "Road Song", weight: 3 },
      { text: "Abbey", weight: 2 },
    ]);
    expect(score(parseQuery("abbey road")!, album)).toBeGreaterThan(score(parseQuery("abbey road")!, mention));
  });
});

describe("rank", () => {
  const items = ["Sun King", "Sunrise", "Sunday Morning", "Here Comes the Sun", "Moonlight"].map((title) => ({
    title,
    fields: indexFields([{ text: title, weight: 3 }]),
  }));

  it("returns matches by score, then tiebreak, up to the limit", () => {
    const result = rank(parseQuery("sun")!, items, (i) => i.fields, 10, (a, b) => a.title.localeCompare(b.title));
    // Whole-word matches first (Sun King also starts with the query), then
    // prefix matches; ties are alphabetical.
    expect(result.map((i) => i.title)).toEqual(["Sun King", "Here Comes the Sun", "Sunday Morning", "Sunrise"]);
    expect(rank(parseQuery("sun")!, items, (i) => i.fields, 2, () => 0)).toHaveLength(2);
    expect(rank(parseQuery("xyz")!, items, (i) => i.fields, 10, () => 0)).toEqual([]);
  });
});
