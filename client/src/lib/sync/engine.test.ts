import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { positionAt, type ClientMessage, type QueueItem, type RoomSnapshot } from "@relayer/shared";
import type { FilePlayer } from "../players/FilePlayer.js";
import { SyncEngine, type CorrectionMode } from "./engine.js";

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
    /** Audio drops out for this long whenever the rate changes mid-playback. */
    private readonly rateGlitchMs = 0,
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
    if (rate !== this.rate) {
      this.rateChanges++;
      if (this.playing) this.readyAt = Math.max(this.readyAt, now() + this.rateGlitchMs);
    }
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

function run(opts: {
  seekLatencyMs: number | (() => number);
  startLatencyMs: number;
  startPosMs?: number;
  rateGlitchMs?: number;
  correction?: CorrectionMode;
}) {
  const player = new FakePlayer(opts.seekLatencyMs, opts.startLatencyMs, opts.rateGlitchMs);
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
    correction: opts.correction,
  });
  const drift = () => player.positionMs() - positionAt(snapshot.playback!, now());
  /** A new room state, e.g. a resume with its 300 ms lead. */
  const resumeAt = (anchorPosMs: number, leadMs = 300) => {
    snapshot.playback = { itemId: "i1", state: "playing", anchorPosMs, anchorTime: now() + leadMs };
    snapshot.rev++;
    engine.kick();
  };
  const pause = () => {
    snapshot.playback = { itemId: "i1", state: "paused", anchorPosMs: positionAt(snapshot.playback!, now()), anchorTime: now() };
    snapshot.rev++;
    engine.kick();
  };
  /** Where the room's timeline is anchored; after a pause, where it paused. */
  const anchorPos = () => snapshot.playback!.anchorPosMs;
  return { player, engine, drift, resumeAt, pause, anchorPos };
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

  it.each([
    // [label, start latency, warning the room gives]
    ["resumes (300 ms warning)", 250, 300],
    ["new tracks (1 s warning)", 900, 1000],
  ])("learns to start early so later %s land on time", async (_label, startLatencyMs, leadMs) => {
    const { engine, drift, resumeAt, pause, anchorPos } = run({ seekLatencyMs: 900, startLatencyMs });
    engine.start();
    await vi.advanceTimersByTimeAsync(10_000);
    const startDrifts: number[] = [];
    for (let i = 0; i < 4; i++) {
      pause();
      await vi.advanceTimersByTimeAsync(2000);
      resumeAt(anchorPos(), leadMs); // resume where it paused
      await vi.advanceTimersByTimeAsync(leadMs + 1000); // 1 s after the anchor
      startDrifts.push(drift());
      await vi.advanceTimersByTimeAsync(5000);
    }
    // The lead matches the start latency (learned from the very first start),
    // so starts land on time.
    expect(engine.stats.startLeadMs).toBeGreaterThan(startLatencyMs * 0.8);
    for (const d of startDrifts) expect(Math.abs(d)).toBeLessThan(50);
    engine.stop();
  });

  it("does not over-learn when the start latency exceeds the warning", async () => {
    const { engine, resumeAt, pause, anchorPos } = run({ seekLatencyMs: 900, startLatencyMs: 900 });
    engine.start();
    await vi.advanceTimersByTimeAsync(10_000);
    for (let i = 0; i < 4; i++) {
      pause();
      await vi.advanceTimersByTimeAsync(2000);
      resumeAt(anchorPos());
      await vi.advanceTimersByTimeAsync(6000);
    }
    // Resumes only give 300 ms of warning; the lead must not creep to its cap.
    expect(engine.stats.startLeadMs).toBeLessThan(1000);
    engine.stop();
  });

  it.each(["rate", "seek"] as const)("stays in sync through repeated seeks while playing (%s mode)", async (correction) => {
    const { player, engine, drift, resumeAt } = run({ seekLatencyMs: 900, startLatencyMs: 900, correction });
    engine.start();
    await vi.advanceTimersByTimeAsync(10_000);
    for (let i = 1; i <= 5; i++) {
      resumeAt(i * 60_000); // someone scrubs: a new position, 300 ms lead
      await vi.advanceTimersByTimeAsync(20_000);
      expect(Math.abs(drift())).toBeLessThan(150);
    }
    // Each scrub may cost a correction seek, but nothing runs away.
    expect(player.seeks).toBeLessThanOrEqual(5 + 5 + 2);
    engine.stop();
  });

  it("in seek mode, never changes the rate and stays in sync on a player that glitches on rate changes", async () => {
    const { player, engine, drift } = run({
      seekLatencyMs: 800,
      startLatencyMs: 900,
      rateGlitchMs: 700,
      startPosMs: 30_000,
      correction: "seek",
    });
    engine.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(player.rateChanges).toBe(0);
    expect(player.seeks).toBeLessThanOrEqual(4);
    expect(Math.abs(drift())).toBeLessThan(150);
    engine.stop();
  });

  it("in seek mode, stays quiet when already in sync", async () => {
    const { player, engine } = run({ seekLatencyMs: 30, startLatencyMs: 30, correction: "seek" });
    engine.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(player.seeks).toBe(0);
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
