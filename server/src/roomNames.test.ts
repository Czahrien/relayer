import { describe, expect, it } from "vitest";
import { ROOM_ID_PATTERN } from "@listening-room/shared";
import { generateRoomName, MOODS, NOUNS, TONES } from "./roomNames.js";

describe("generateRoomName", () => {
  it("produces adjective-adjective-noun-NN names from the lists", () => {
    for (let i = 0; i < 500; i++) {
      const name = generateRoomName();
      const [mood, tone, noun, number, ...rest] = name.split("-");
      expect(rest).toEqual([]);
      expect(MOODS).toContain(mood);
      expect(TONES).toContain(tone);
      expect(NOUNS).toContain(noun);
      expect(number).toMatch(/^[1-9][0-9]$/);
      expect(name).toMatch(ROOM_ID_PATTERN);
    }
  });

  it("uses clean, distinct word lists", () => {
    const all = [...MOODS, ...TONES, ...NOUNS];
    for (const word of all) expect(word).toMatch(/^[a-z]{3,9}$/);
    // No duplicates within or across lists, so names never repeat a word.
    expect(new Set(all).size).toBe(all.length);
  });

  it("keeps enough combinations that names are hard to guess", () => {
    const combinations = MOODS.length * TONES.length * NOUNS.length * 90;
    expect(combinations).toBeGreaterThan(400_000_000);
  });

  it("varies", () => {
    const names = new Set(Array.from({ length: 1000 }, generateRoomName));
    expect(names.size).toBeGreaterThan(995);
  });
});
