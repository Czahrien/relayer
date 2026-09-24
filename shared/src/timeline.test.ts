import { describe, expect, it } from "vitest";
import { effectivePositionAt, formatTime, positionAt } from "./timeline.js";
import type { Playback } from "./protocol.js";

const pb = (state: Playback["state"], anchorPosMs: number, anchorTime: number): Playback => ({
  itemId: "x",
  state,
  anchorPosMs,
  anchorTime,
});

describe("positionAt", () => {
  it("advances with server time while playing", () => {
    expect(positionAt(pb("playing", 5000, 1000), 3000)).toBe(7000);
  });

  it("is negative before a future anchor", () => {
    expect(positionAt(pb("playing", 0, 2000), 1500)).toBe(-500);
  });

  it("stays at the anchor while paused or waiting", () => {
    expect(positionAt(pb("paused", 5000, 1000), 99_000)).toBe(5000);
    expect(positionAt(pb("waiting", 0, 1000), 99_000)).toBe(0);
  });
});

describe("effectivePositionAt", () => {
  it("never reports less than the anchor position during the lead", () => {
    expect(effectivePositionAt(pb("playing", 30_000, 2000), 1800)).toBe(30_000);
  });

  it("clamps to the duration", () => {
    expect(effectivePositionAt(pb("playing", 0, 0), 500_000, 200_000)).toBe(200_000);
  });
});

describe("formatTime", () => {
  it.each([
    [0, "0:00"],
    [999, "0:00"],
    [61_000, "1:01"],
    [3_600_000 + 62_000, "1:01:02"],
    [undefined, "–:––"],
  ])("%s → %s", (ms, text) => {
    expect(formatTime(ms)).toBe(text);
  });
});
