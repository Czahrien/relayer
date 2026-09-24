import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { positionAt, type ClientMessage, type QueueItem, type RoomSnapshot } from "@listening-room/shared";
import type { FilePlayer } from "../players/FilePlayer.js";
import { SyncEngine } from "./engine.js";

const now = () => Date.now();

/**
 * A simulated audio element. Seeks and starts take a while to become audible,
 * the way Safari behaves when it has to fetch a new byte range: until then the
 * position stays at the seek target.
 */
class FakePlayer {
  readonly kind = "file" as const;
  seeks = 0;
  rateChanges = 0;
  private pos = 0;
  private at = now();
  private playing = false;
  private rate = 1;
  private readyAt = 0;

  private readonly seekLatency: () => number;

  constructor(
    seekLatencyMs: number | (() => number),
    private readonly startLatencyMs: number,
  ) {
    this.seekLatency = typeof seekLatencyMs === "number" ? () => seekLatencyMs : seekLatencyMs;
  }

  private advance() {
    const t = now();
    if (this.playing) {
      const from = Math.max(this.at, this.readyAt);
      if (t > from) this.pos += (t - from) * this.rate;
    }
    this.at = t;
  }

  positionMs() {
    this.advance();
    return this.pos;
  }
  seek(ms: number) {
    this.advance();
    this.pos = ms;
    this.readyAt = now() + this.seekLatency();
    this.seeks++;
  }
  play() {
    this.advance();
    if (!this.playing) {
      this.playing = true;
      this.readyAt = Math.max(this.readyAt, now() + this.startLatencyMs);
    }
    return Promise.resolve();
  }
  pause() {
    this.advance();
    this.playing = false;
  }
  setRate(rate: number) {
    this.advance();
    if (rate !== this.rate) this.rateChanges++;
    this.rate = rate;
  }
  isBuffering() {
    return now() < this.readyAt;
  }
  isPaused() {
    return !this.playing;
  }
  isEnded() {
    return false;
  }
  load() {
    return Promise.resolve();
  }
  preload() {}
  setVolume() {}
  onEnded() {}
  onError() {}
  onDuration() {}
  destroy() {}
}

const item: QueueItem = {
  id: "i1",
  kind: "file",
  status: "ready",
  mediaUrl: "/media/r/i1",
  title: "Song",
  durationMs: 10 * 60_000,
  addedBy: "Ann",
  addedAt: 0,
};

function run(opts: { seekLatencyMs: number | (() => number); startLatencyMs: number; startPosMs?: number }) {
  const player = new FakePlayer(opts.seekLatencyMs, opts.startLatencyMs);
  const snapshot: RoomSnapshot = {
    roomId: "r",
    rev: 1,
    items: [item],
    currentIndex: 0,
    listeners: [],
    // A new track (anchor 1 s ahead), or a late join into a playing track.
    playback: opts.startPosMs
      ? { itemId: "i1", state: "playing", anchorPosMs: opts.startPosMs, anchorTime: now() }
      : { itemId: "i1", state: "playing", anchorPosMs: 0, anchorTime: now() + 1000 },
  };
  const sent: ClientMessage[] = [];
  const engine = new SyncEngine({
    snapshot: () => snapshot,
    serverNow: now,
    clockSynced: () => true,
    send: (m) => sent.push(m),
    file: player as unknown as FilePlayer,
  });
  const drift = () => player.positionMs() - positionAt(snapshot.playback!, now());
  return { player, engine, drift };
}

describe("SyncEngine", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stays in sync with a fast player", async () => {
    const { player, engine, drift } = run({ seekLatencyMs: 30, startLatencyMs: 30 });
    engine.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(player.seeks).toBeLessThanOrEqual(1);
    expect(Math.abs(drift())).toBeLessThan(50);
    engine.stop();
  });

  it.each([
    ["a new track", undefined],
    ["a late join", 90_000],
  ])("does not get stuck in a seek loop when seeks are slow (%s)", async (_label, startPosMs) => {
    const { player, engine, drift } = run({ seekLatencyMs: 1000, startLatencyMs: 1000, startPosMs });
    engine.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(player.seeks).toBeLessThanOrEqual(4);
    expect(Math.abs(drift())).toBeLessThan(50);
    engine.stop();
  });

  it("converges when seek times vary", async () => {
    let seed = 7;
    const jitter = () => {
      seed = (seed * 16807) % 2147483647;
      return 600 + (seed % 800); // 0.6-1.4 s
    };
    const { player, engine, drift } = run({ seekLatencyMs: jitter, startLatencyMs: 900, startPosMs: 30_000 });
    engine.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(player.seeks).toBeLessThanOrEqual(6);
    expect(Math.abs(drift())).toBeLessThan(50);
    engine.stop();
  });

  it("copes with seeks slower than the cooldown", async () => {
    const { player, engine, drift } = run({ seekLatencyMs: 2500, startLatencyMs: 2500, startPosMs: 30_000 });
    engine.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(player.seeks).toBeLessThanOrEqual(4);
    expect(Math.abs(drift())).toBeLessThan(50);
    engine.stop();
  });

  it("does not change the playback rate on every tick", async () => {
    const { player, engine } = run({ seekLatencyMs: 300, startLatencyMs: 300 });
    engine.start();
    await vi.advanceTimersByTimeAsync(60_000);
    // 120 ticks; nudging should settle rather than retune continuously.
    expect(player.rateChanges).toBeLessThan(20);
    engine.stop();
  });
});
