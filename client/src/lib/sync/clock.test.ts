import { describe, expect, it } from "vitest";
import { bestSample, ClockSync, makeSample } from "./clock.js";

const TRUE_OFFSET = 5_000; // server clock is 5 s ahead of the client

/** A ping/pong exchange with the given one-way delays. */
function exchange(t0: number, up: number, down: number) {
  const serverTime = t0 + up + TRUE_OFFSET;
  const t1 = t0 + up + down;
  return { t0, t1, serverTime };
}

describe("makeSample", () => {
  it("is exact for symmetric delays", () => {
    const { t0, t1, serverTime } = exchange(1000, 40, 40);
    expect(makeSample(t0, t1, serverTime)).toEqual({ at: t1, rtt: 80, offset: TRUE_OFFSET });
  });

  it("errs by half the asymmetry", () => {
    const { t0, t1, serverTime } = exchange(1000, 90, 10);
    expect(makeSample(t0, t1, serverTime).offset).toBe(TRUE_OFFSET + 40);
  });
});

describe("bestSample", () => {
  it("prefers the lowest RTT, whose asymmetry error is smallest", () => {
    const delays: [number, number][] = [
      [120, 15], // rtt 135, error +52.5
      [20, 180], // rtt 200, error -80
      [9, 14], //  rtt 23,  error -2.5
      [60, 5], //  rtt 65,  error +27.5
      [300, 250],
    ];
    const samples = delays.map(([up, down], i) => {
      const e = exchange(10_000 + i * 100, up, down);
      return makeSample(e.t0, e.t1, e.serverTime);
    });
    const best = bestSample(samples, 11_000)!;
    expect(best.rtt).toBe(23);
    expect(Math.abs(best.offset - TRUE_OFFSET)).toBeLessThanOrEqual(2.5);
  });

  it("ignores samples older than the window", () => {
    const old = makeSample(0, 10, 5 + TRUE_OFFSET); // rtt 10
    const recent = makeSample(200_000, 200_050, 200_025 + TRUE_OFFSET); // rtt 50
    expect(bestSample([old, recent], 200_100, 120_000)).toBe(recent);
  });
});

describe("ClockSync", () => {
  it("keeps the best offset as pongs arrive", () => {
    let now = 1000;
    const sync = new ClockSync(() => {}, () => now);
    expect(sync.synced).toBe(false);

    // Slow first sample.
    let e = exchange(now, 200, 50);
    now = e.t1;
    sync.handlePong(e.t0, e.serverTime);
    expect(sync.offset).toBe(TRUE_OFFSET + 75);

    // A faster one replaces it.
    e = exchange(now, 12, 8);
    now = e.t1;
    sync.handlePong(e.t0, e.serverTime);
    expect(sync.offset).toBe(TRUE_OFFSET + 2);
    expect(sync.bestRtt).toBe(20);

    // A slower later one doesn't.
    e = exchange(now, 100, 10);
    now = e.t1;
    sync.handlePong(e.t0, e.serverTime);
    expect(sync.bestRtt).toBe(20);
    expect(sync.serverNow()).toBe(now + TRUE_OFFSET + 2);

    // Two minutes later the old best expires.
    now += 121_000;
    e = exchange(now, 30, 30);
    now = e.t1;
    sync.handlePong(e.t0, e.serverTime);
    expect(sync.bestRtt).toBe(60);
    expect(sync.offset).toBe(TRUE_OFFSET);
  });
});
