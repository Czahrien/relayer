import type { Playback } from "./protocol.js";

/** Lead before a newly started track begins, so clients can load the source (§6.3). */
export const NEW_TRACK_LEAD_MS = 1000;
/** Lead before a resume or a seek-while-playing takes effect (§6.3). */
export const RESUME_LEAD_MS = 300;
/** Grace after the computed end of a track before the server advances (§6.4). */
export const END_GRACE_MS = 250;
/** An `ended` report is accepted only this close to a known duration (§6.4). */
export const ENDED_TOLERANCE_MS = 2000;
/** `previous` restarts the current item when past this position (§5). */
export const PREVIOUS_RESTART_THRESHOLD_MS = 3000;

/**
 * Playhead position at `serverNow`. Negative when `anchorTime` is still in the
 * future, which clients treat as "loaded, paused at 0, start at the anchor instant".
 */
export function positionAt(pb: Playback, serverNow: number): number {
  if (pb.state !== "playing") return pb.anchorPosMs;
  return pb.anchorPosMs + (serverNow - pb.anchorTime);
}

/**
 * Position for decisions like pausing or `previous`: never behind the anchor
 * position (the lead hasn't elapsed yet) and never past a known duration.
 */
export function effectivePositionAt(pb: Playback, serverNow: number, durationMs?: number): number {
  let pos = Math.max(pb.anchorPosMs, positionAt(pb, serverNow));
  if (durationMs !== undefined) pos = Math.min(pos, durationMs);
  return Math.max(0, pos);
}

export function formatTime(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return "–:––";
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
