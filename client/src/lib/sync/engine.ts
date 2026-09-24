import {
  positionAt,
  type ClientMessage,
  type ListenerSyncState,
  type QueueItem,
  type RoomSnapshot,
} from "@listening-room/shared";
import type { FilePlayer } from "../players/FilePlayer.js";
import { RecoverableError, type Player } from "../players/Player.js";

const FILE_TICK_MS = 500;
const YOUTUBE_TICK_MS = 1000;
const STATUS_EVERY_MS = 3000;
const SEEK_COOLDOWN_MS = 1500;
const PAUSED_TOLERANCE_MS = 250;
const HOLD_TOLERANCE_MS = 30;
const FILE_DEADBAND_MS = 40;
const FILE_HARD_SEEK_MS = 750;
const YOUTUBE_HARD_SEEK_MS = 600;
/** Upper bound for the learned seek lead. */
const MAX_SEEK_LEAD_MS = 3000;
/** Wait before reloading after a local (e.g. network) failure. */
const RETRY_DELAY_MS = 2000;
/** Near the end, let the player finish on its own rather than correcting. */
const END_ZONE_MS = 250;

export interface EngineStats {
  driftMs: number | null;
  rate: number;
  state: ListenerSyncState;
  itemId: string | null;
  /** How far ahead hard seeks aim, learned from how long this client's seeks take. */
  seekLeadMs: number;
  lastAction: string;
}

export interface EngineDeps {
  snapshot(): RoomSnapshot | null;
  serverNow(): number;
  clockSynced(): boolean;
  send(message: ClientMessage): void;
  file: FilePlayer;
  youtube?: Player;
}

/**
 * Continuously steers the active Player toward the room timeline (§6.6).
 * It never changes the room: it only reads snapshots and reports back.
 */
export class SyncEngine {
  readonly stats: EngineStats = {
    driftMs: null,
    rate: 1,
    state: "idle",
    itemId: null,
    seekLeadMs: 0,
    lastAction: "",
  };

  private active: Player | null = null;
  private loadedId: string | null = null;
  private loadingId: string | null = null;
  private lastSeekAt = Number.NEGATIVE_INFINITY;
  private startTimer: { key: string; handle: ReturnType<typeof setTimeout> } | null = null;
  private tickTimer: ReturnType<typeof setTimeout> | null = null;
  private statusTimer: ReturnType<typeof setInterval> | null = null;
  private reportedDuration = new Set<string>();
  private reportedError = new Set<string>();
  private running = false;
  /**
   * Per-player seek lead. A hard seek to where the room is *now* lands late by
   * however long the seek takes to become audible (on Safari, fetching a new
   * byte range can take over a second). Without a lead, that lateness exceeds
   * the hard-seek threshold and the player seeks forever.
   */
  private readonly seekLead = new Map<Player, number>();
  /** The player whose last hard seek hasn't been measured yet. */
  private unmeasuredSeek: Player | null = null;
  private retryAfter = 0;

  constructor(private readonly deps: EngineDeps) {
    for (const player of this.players()) {
      player.onEnded(() => {
        if (player === this.active && this.loadedId) this.deps.send({ type: "ended", itemId: this.loadedId });
      });
      player.onError((message, recoverable) => {
        const id = player === this.active ? (this.loadingId ?? this.loadedId) : null;
        if (!id) return;
        if (recoverable) this.retryLater(message);
        else this.fail(id, message);
      });
      player.onDuration((ms) => {
        const id = player === this.active ? (this.loadedId ?? this.loadingId) : null;
        if (id) this.maybeReportDuration(id, ms);
      });
    }
  }

  start(): void {
    this.running = true;
    this.statusTimer = setInterval(() => this.sendStatus(), STATUS_EVERY_MS);
    this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.clearStartTimer();
    for (const player of this.players()) player.pause();
  }

  /** Re-evaluate now, e.g. because a new snapshot arrived. */
  kick(): void {
    if (this.running) this.tick();
  }

  get activePlayer(): Player | null {
    return this.active;
  }

  private players(): Player[] {
    return this.deps.youtube ? [this.deps.file, this.deps.youtube] : [this.deps.file];
  }

  private playerFor(item: QueueItem): Player | null {
    if (item.kind === "youtube") return this.deps.youtube ?? null;
    // Files and (future) library items both stream from a media URL.
    return item.mediaUrl ? this.deps.file : null;
  }

  private tick(): void {
    if (this.tickTimer) clearTimeout(this.tickTimer);
    try {
      this.step();
    } finally {
      const interval = this.active?.kind === "youtube" ? YOUTUBE_TICK_MS : FILE_TICK_MS;
      if (this.running) this.tickTimer = setTimeout(() => this.tick(), interval);
    }
  }

  private step(): void {
    const snap = this.deps.snapshot();
    const pb = snap?.playback ?? null;
    const item = pb && snap ? snap.items[snap.currentIndex] : undefined;

    if (!snap || !pb || !item || item.id !== pb.itemId) {
      this.clearStartTimer();
      this.active?.pause();
      this.setStats(null, "idle");
      return;
    }

    this.preloadNext(snap);

    if (pb.state === "waiting" || item.status !== "ready") {
      this.clearStartTimer();
      this.active?.pause();
      this.setStats(null, "paused");
      return;
    }

    const player = this.playerFor(item);
    if (!player) {
      this.fail(item.id, "This item has nothing this browser can play.");
      return;
    }
    if (player !== this.active) {
      this.active?.pause();
      this.active = player;
      this.loadedId = null;
    }
    if (this.loadedId !== item.id) {
      if (performance.now() >= this.retryAfter) this.load(player, item);
      else this.setStats(null, "buffering");
      return;
    }
    if (!this.deps.clockSynced()) {
      this.setStats(null, "loading");
      return;
    }

    const now = this.deps.serverNow();
    const actual = player.positionMs();

    if (pb.state === "paused") {
      this.clearStartTimer();
      player.pause();
      if (Math.abs(actual - pb.anchorPosMs) > PAUSED_TOLERANCE_MS) this.seek(player, pb.anchorPosMs, "paused seek");
      player.setRate(1);
      this.setStats(null, "paused");
      return;
    }

    // Playing, but the anchor is still ahead: hold at the anchor position and
    // start exactly at the anchor instant (§6.3). For a new track that's 0.
    if (now < pb.anchorTime) {
      player.pause();
      player.setRate(1);
      if (Math.abs(actual - pb.anchorPosMs) > HOLD_TOLERANCE_MS) player.seek(pb.anchorPosMs);
      this.scheduleStart(player, `${item.id}:${pb.anchorTime}:${pb.anchorPosMs}`, pb.anchorTime - now);
      this.setStats(null, "playing");
      return;
    }
    this.clearStartTimer();

    const expected = positionAt(pb, now);
    const durationMs = item.durationMs;
    if (player.isEnded() || (durationMs !== undefined && expected >= durationMs - END_ZONE_MS)) {
      // Let it run out; the server advances the room.
      this.setStats(null, "playing");
      return;
    }

    if (player.isBuffering() || now - this.lastSeekAt < SEEK_COOLDOWN_MS) {
      this.ensurePlaying(player);
      this.setStats(null, player.isBuffering() ? "buffering" : "playing");
      return;
    }

    const drift = actual - expected;
    const magnitude = Math.abs(drift);
    if (this.unmeasuredSeek === player) {
      // Where the last hard seek landed tells us how much lead it needed.
      this.unmeasuredSeek = null;
      const lead = Math.min(MAX_SEEK_LEAD_MS, Math.max(0, (this.seekLead.get(player) ?? 0) - drift));
      this.seekLead.set(player, lead);
    }
    if (player.kind === "youtube") {
      if (magnitude > YOUTUBE_HARD_SEEK_MS) this.hardSeek(player, expected, drift);
    } else if (magnitude > FILE_HARD_SEEK_MS) {
      player.setRate(1);
      this.stats.rate = 1;
      this.hardSeek(player, expected, drift);
    } else if (magnitude <= FILE_DEADBAND_MS) {
      player.setRate(1);
      this.stats.rate = 1;
    } else {
      const rate = Math.min(1.05, Math.max(0.95, 1 - drift / 4000));
      player.setRate(rate);
      this.stats.rate = rate;
    }
    this.ensurePlaying(player);
    this.setStats(drift, "playing");
  }

  private load(player: Player, item: QueueItem): void {
    if (this.loadingId === item.id) return;
    this.loadingId = item.id;
    this.clearStartTimer();
    this.setStats(null, "loading");
    this.stats.lastAction = `load ${item.title}`;
    player.load(item).then(
      () => {
        if (this.loadingId !== item.id) return;
        this.loadingId = null;
        this.loadedId = item.id;
        this.kick();
      },
      (err: unknown) => {
        if (this.loadingId !== item.id) return;
        this.loadingId = null;
        if (err instanceof RecoverableError) this.retryLater(err.message);
        else this.fail(item.id, err instanceof Error ? err.message : "The item couldn't be loaded.");
      },
    );
  }

  /** A drift correction: aim ahead by the learned lead, then measure where it landed. */
  private hardSeek(player: Player, expected: number, drift: number): void {
    const lead = this.seekLead.get(player) ?? 0;
    this.seek(player, expected + lead, `seek (drift ${Math.round(drift)} ms, lead ${Math.round(lead)} ms)`);
    this.unmeasuredSeek = player;
  }

  private seek(player: Player, ms: number, reason: string): void {
    player.seek(ms);
    this.lastSeekAt = this.deps.serverNow();
    this.stats.lastAction = reason;
  }

  private ensurePlaying(player: Player): void {
    if (!player.isPaused()) return;
    player.play().catch((err: unknown) => {
      this.stats.lastAction = `play blocked: ${err instanceof Error ? err.name : "unknown"}`;
    });
  }

  private scheduleStart(player: Player, key: string, delayMs: number): void {
    if (this.startTimer?.key === key) return;
    this.clearStartTimer();
    this.startTimer = {
      key,
      handle: setTimeout(() => {
        this.startTimer = null;
        if (player !== this.active) return;
        player.play().catch(() => {});
        this.stats.lastAction = "started at anchor";
      }, delayMs),
    };
  }

  private clearStartTimer(): void {
    if (!this.startTimer) return;
    clearTimeout(this.startTimer.handle);
    this.startTimer = null;
  }

  private preloadNext(snap: RoomSnapshot): void {
    const next = snap.items
      .slice(snap.currentIndex + 1)
      .find((item) => item.status === "ready" && item.kind !== "youtube" && item.mediaUrl);
    this.deps.file.preload(next ?? null);
  }

  private maybeReportDuration(itemId: string, ms: number): void {
    const item = this.deps.snapshot()?.items.find((i) => i.id === itemId);
    if (!item || item.durationMs !== undefined || this.reportedDuration.has(itemId)) return;
    this.reportedDuration.add(itemId);
    this.deps.send({ type: "reportDuration", itemId, durationMs: Math.round(ms) });
  }

  /** A local failure: drop the loaded item and load it again shortly. */
  private retryLater(message: string): void {
    this.loadedId = null;
    this.loadingId = null;
    this.retryAfter = performance.now() + RETRY_DELAY_MS;
    this.stats.lastAction = `retrying: ${message}`;
  }

  private fail(itemId: string, message: string): void {
    if (this.reportedError.has(itemId)) return;
    this.reportedError.add(itemId);
    if (this.loadedId === itemId) this.loadedId = null;
    this.stats.lastAction = `error: ${message}`;
    this.deps.send({ type: "itemError", itemId, message });
  }

  private setStats(driftMs: number | null, state: ListenerSyncState): void {
    this.stats.driftMs = driftMs;
    this.stats.state = state;
    this.stats.itemId = this.loadedId;
    this.stats.seekLeadMs = this.active ? (this.seekLead.get(this.active) ?? 0) : 0;
    if (state !== "playing") this.stats.rate = 1;
  }

  private sendStatus(): void {
    const { driftMs, state } = this.stats;
    this.deps.send({ type: "status", driftMs: driftMs === null ? null : Math.round(driftMs), state });
  }
}
