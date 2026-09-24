import type { ItemKind, QueueItem } from "@relayer/shared";

/**
 * A failure local to this client (e.g. the network dropped). The engine retries
 * instead of reporting `itemError`, which would skip the item for everyone.
 */
export class RecoverableError extends Error {}

/**
 * The item won't play in this browser but may play for others: YouTube decides
 * whether to embed a video from the page's address and referrer, so a page
 * opened by IP address, or an extension that strips referrers, is refused
 * where everyone else plays fine. The engine sits the item out and reports it
 * with `local`, and the room skips it only if it fails for everyone.
 */
export class LocalError extends Error {}

/**
 * A local playback backend. The sync engine steers whichever player matches
 * the current item's kind; adding a source type means adding a Player (§2).
 */
export interface Player {
  readonly kind: ItemKind;
  load(item: QueueItem): Promise<void>; // resolves when ready to play
  play(): Promise<void>;
  pause(): void;
  seek(ms: number): void;
  positionMs(): number;
  setRate(rate: number): void; // no-op for YouTube in this slice
  setVolume(v: number): void; // 0..1
  isBuffering(): boolean;
  // Additions to §6.7: the engine must not call play() on a finished item,
  // because an ended <audio> element restarts from 0.
  isPaused(): boolean;
  isEnded(): boolean;
  onEnded(cb: () => void): void;
  /** A failure after load(): a RecoverableError, a LocalError, or any other Error. */
  onError(cb: (error: Error) => void): void;
  onDuration(cb: (ms: number) => void): void;
  destroy(): void;
}
