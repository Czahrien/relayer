import {
  positionAt,
  type ClientMessage,
  type ListenerSyncState,
  type QueueItem,
  type RoomSnapshot,
} from "@relayer/shared";
import type { FilePlayer } from "../players/FilePlayer.js";
import { LocalError, RecoverableError, type Player } from "../players/Player.js";

const FILE_TICK_MS = 500;
const YOUTUBE_TICK_MS = 1000;
const STATUS_EVERY_MS = 3000;
const SEEK_COOLDOWN_MS = 1500;
const PAUSED_TOLERANCE_MS = 250;
const FILE_DEADBAND_MS = 40;
const FILE_HARD_SEEK_MS = 750;
const YOUTUBE_HARD_SEEK_MS = 600;
/** Upper bounds for the learned seek and start leads. */
const MAX_SEEK_LEAD_MS = 3000;
const MAX_START_LEAD_MS = 2000;
/**
 * Seek-only correction (see CorrectionMode): seek when off by more than this
 * for two ticks in a row, so one noisy reading doesn't cause a seek.
 */
const SEEK_MODE_THRESHOLD_MS = 150;
const SEEK_MODE_CONFIRM_TICKS = 2;
const LOG_LENGTH = 8;
/** Wait before reloading after a local (e.g. network) failure. */
const RETRY_DELAY_MS = 2000;
/** Near the end, let the player finish on its own rather than correcting. */
const END_ZONE_MS = 250;

/**
 * How file playback is corrected. "rate" nudges playbackRate (smooth, the
 * default). "seek" never changes the rate and corrects with small seeks
 * instead, for browsers that glitch when the rate changes (WebKit).
 */
export type CorrectionMode = "rate" | "seek";

export interface EngineStats {
  driftMs: number | null;
  rate: number;
  state: ListenerSyncState;
  itemId: string | null;
  mode: CorrectionMode;
  /** How far ahead hard seeks aim, learned from how long this client's seeks take. */
  seekLeadMs: number;
  /** How early play() is called before a start, learned from how long starts take. */
  startLeadMs: number;
  lastAction: string;
  /** Recent actions, newest last, for diagnosing sync from the debug panel. */
  log: string[];
}

export interface EngineDeps {
  snapshot(): RoomSnapshot | null;
  serverNow(): number;
  clockSynced(): boolean;
  send(message: ClientMessage): void;
  file: FilePlayer;
  youtube?: Player;
  correction?: CorrectionMode;
  /** An item won't play in this browser, though it may for others (LocalError). */
  onBlockedHere?(itemId: string, message: string): void;
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
    mode: "rate",
    seekLeadMs: 0,
    startLeadMs: 0,
    lastAction: "",
    log: [],
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
  /** Items that won't play here; this client sits them out while the room plays on. */
  private blockedHere = new Set<string>();
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
  /**
   * Per-player start lead: play() takes a while to become audible (about a
   * second on Safari), so starts are issued this much before the anchor.
   */
  private readonly startLead = new Map<Player, number>();
  /** The player whose last scheduled start hasn't been measured yet. */
  private unmeasuredStart: Player | null = null;
  /** The start key whose play() has already been issued (possibly early). */
  private startedKey: string | null = null;
  /** The start key that needed a seek while holding; its timing says nothing about start latency. */
  private seekedForKey: string | null = null;
  private overThresholdTicks = 0;
  private retryAfter = 0;
  private readonly mode: CorrectionMode;

  constructor(private readonly deps: EngineDeps) {
    this.mode = deps.correction ?? "rate";
    this.stats.mode = this.mode;
    for (const player of this.players()) {
      player.onEnded(() => {
        if (player === this.active && this.loadedId) this.deps.send({ type: "ended", itemId: this.loadedId });
      });
      player.onError((error) => {
        const id = player === this.active ? (this.loadingId ?? this.loadedId) : null;
        if (id) this.handleFailure(id, error);
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

    if (this.blockedHere.has(item.id)) {
      this.clearStartTimer();
      this.active?.pause();
      this.setStats(null, "blocked");
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

    // Playing, but the anchor is still ahead: hold, and start at the anchor
    // instant (§6.3) minus the learned start lead. For a new track the anchor
    // position is 0.
    if (now < pb.anchorTime) {
      const key = `${item.id}:${pb.anchorTime}:${pb.anchorPosMs}`;
      if (this.startedKey !== key) {
        player.pause();
        player.setRate(1);
        // Seeks can be slow, so a small offset (say, where a pause left the
        // player) shifts the start time instead: a player 40 ms behind starts
        // 40 ms early. Only a large offset is worth a seek.
        let offset = actual - pb.anchorPosMs;
        if (Math.abs(offset) > PAUSED_TOLERANCE_MS) {
          player.seek(pb.anchorPosMs);
          this.seekedForKey = key;
          offset = 0;
        }
        this.scheduleStart(player, key, pb.anchorTime - now + offset);
      }
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
    // How far off the last seek or start landed tells us how much lead it needed.
    if (this.unmeasuredSeek === player) {
      this.unmeasuredSeek = null;
      this.seekLead.set(player, learn(this.seekLead.get(player), drift, MAX_SEEK_LEAD_MS));
    }
    if (this.unmeasuredStart === player) {
      this.unmeasuredStart = null;
      this.startLead.set(player, learn(this.startLead.get(player), drift, MAX_START_LEAD_MS));
    }

    if (player.kind === "youtube") {
      if (magnitude > YOUTUBE_HARD_SEEK_MS) this.hardSeek(player, expected, drift);
    } else if (this.mode === "seek") {
      this.overThresholdTicks = magnitude > SEEK_MODE_THRESHOLD_MS ? this.overThresholdTicks + 1 : 0;
      if (this.overThresholdTicks >= SEEK_MODE_CONFIRM_TICKS) {
        this.overThresholdTicks = 0;
        this.hardSeek(player, expected, drift);
      }
    } else if (magnitude > FILE_HARD_SEEK_MS) {
      this.setRate(player, 1);
      this.hardSeek(player, expected, drift);
    } else if (magnitude <= FILE_DEADBAND_MS) {
      this.setRate(player, 1);
    } else {
      this.setRate(player, Math.min(1.05, Math.max(0.95, 1 - drift / 4000)));
    }
    this.ensurePlaying(player);
    this.setStats(drift, "playing");
  }

  private load(player: Player, item: QueueItem): void {
    if (this.loadingId === item.id) return;
    this.loadingId = item.id;
    this.clearStartTimer();
    this.setStats(null, "loading");
    this.note(`load ${item.title}`);
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
        this.handleFailure(item.id, err instanceof Error ? err : new Error("The item couldn't be loaded."));
      },
    );
  }

  /** A drift correction: aim ahead by the learned lead, then measure where it landed. */
  private hardSeek(player: Player, expected: number, drift: number): void {
    const lead = this.seekLead.get(player) ?? 0;
    this.seek(player, expected + lead, `seek (drift ${Math.round(drift)}, lead ${Math.round(lead)})`);
    this.unmeasuredSeek = player;
    this.unmeasuredStart = null; // the seek overrides whatever the start did
  }

  private seek(player: Player, ms: number, reason: string): void {
    player.seek(ms);
    this.lastSeekAt = this.deps.serverNow();
    this.note(reason);
  }

  private setRate(player: Player, rate: number): void {
    // Log only when leaving or returning to normal speed; nudges change every tick.
    if ((rate === 1) !== (this.stats.rate === 1)) this.note(rate === 1 ? "rate 1" : `rate ${rate.toFixed(3)}`);
    player.setRate(rate);
    this.stats.rate = rate;
  }

  private ensurePlaying(player: Player): void {
    if (!player.isPaused()) return;
    player.play().catch((err: unknown) => {
      this.note(`play blocked: ${err instanceof Error ? err.name : "unknown"}`);
    });
  }

  private scheduleStart(player: Player, key: string, delayMs: number): void {
    if (this.startTimer?.key === key) return;
    this.clearStartTimer();
    const lead = this.startLead.get(player) ?? 0;
    // A resume gives only 300 ms of warning; if the lead doesn't fit, the start
    // is late regardless and its timing says nothing new about the lead.
    const fits = delayMs >= lead;
    this.startTimer = {
      key,
      handle: setTimeout(
        () => {
          this.startTimer = null;
          if (player !== this.active) return;
          this.startedKey = key;
          // Learn only from plain starts where the lead fit; one that also had to
          // seek mixes in seek time.
          this.unmeasuredStart = fits && this.seekedForKey !== key ? player : null;
          player.play().catch(() => {});
          this.note(`start (lead ${Math.round(lead)})`);
        },
        Math.max(0, delayMs - lead),
      ),
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

  private handleFailure(itemId: string, error: Error): void {
    if (error instanceof RecoverableError) this.retryLater(error.message);
    else if (error instanceof LocalError) this.blockHere(itemId, error.message);
    else this.fail(itemId, error.message);
  }

  /** Sits the item out here and tells the room, which skips it only if it fails for everyone. */
  private blockHere(itemId: string, message: string): void {
    if (this.blockedHere.has(itemId)) return;
    this.blockedHere.add(itemId);
    if (this.loadedId === itemId) this.loadedId = null;
    this.active?.pause();
    this.note(`blocked here: ${message}`);
    this.deps.send({ type: "itemError", itemId, message, local: true });
    this.deps.onBlockedHere?.(itemId, message);
    this.kick();
  }

  /** A local failure: drop the loaded item and load it again shortly. */
  private retryLater(message: string): void {
    this.loadedId = null;
    this.loadingId = null;
    this.retryAfter = performance.now() + RETRY_DELAY_MS;
    this.note(`retrying: ${message}`);
  }

  private fail(itemId: string, message: string): void {
    if (this.reportedError.has(itemId)) return;
    this.reportedError.add(itemId);
    if (this.loadedId === itemId) this.loadedId = null;
    this.note(`error: ${message}`);
    this.deps.send({ type: "itemError", itemId, message });
  }

  private setStats(driftMs: number | null, state: ListenerSyncState): void {
    this.stats.driftMs = driftMs;
    this.stats.state = state;
    this.stats.itemId = this.loadedId;
    this.stats.seekLeadMs = this.active ? (this.seekLead.get(this.active) ?? 0) : 0;
    this.stats.startLeadMs = this.active ? (this.startLead.get(this.active) ?? 0) : 0;
    if (state !== "playing") this.stats.rate = 1;
  }

  private note(action: string): void {
    this.stats.lastAction = action;
    const t = new Date(this.deps.serverNow());
    const stamp = `${String(t.getMinutes()).padStart(2, "0")}:${String(t.getSeconds()).padStart(2, "0")}`;
    const drift = this.stats.driftMs === null ? "" : ` [${Math.round(this.stats.driftMs)}]`;
    this.stats.log = [...this.stats.log, `${stamp} ${action}${drift}`].slice(-LOG_LENGTH);
  }

  private sendStatus(): void {
    const { driftMs, state } = this.stats;
    this.deps.send({ type: "status", driftMs: driftMs === null ? null : Math.round(driftMs), state });
  }
}

/** Adjusts a lead by where the last attempt landed: late (negative drift) means more lead. */
function learn(lead: number | undefined, drift: number, max: number): number {
  return Math.min(max, Math.max(0, (lead ?? 0) - drift));
}
