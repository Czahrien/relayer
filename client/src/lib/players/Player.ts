import type { ItemKind, QueueItem } from "@relayer/shared";

/**
 * A failure local to this client (e.g. the network dropped). The engine retries
 * instead of reporting `itemError`, which would skip the item for everyone.
 */
export class RecoverableError extends Error {}

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
  /** `recoverable` errors are retried locally rather than reported to the room. */
  onError(cb: (message: string, recoverable: boolean) => void): void;
  onDuration(cb: (ms: number) => void): void;
  destroy(): void;
}
