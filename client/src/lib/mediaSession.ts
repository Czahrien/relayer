import { effectivePositionAt, type Playback, type QueueItem } from "@relayer/shared";
import type { RoomClient } from "./room.svelte.js";

/**
 * Lock-screen and hardware media keys for file items (§8). Handlers send room
 * commands; the room, not the local player, decides what happens.
 */
export function registerMediaSessionHandlers(client: RoomClient): () => void {
  if (!("mediaSession" in navigator)) return () => {};
  const session = navigator.mediaSession;
  const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
    ["play", () => client.send({ type: "play" })],
    ["pause", () => client.send({ type: "pause" })],
    ["nexttrack", () => client.send({ type: "next" })],
    ["previoustrack", () => client.send({ type: "previous" })],
    ["seekto", (details) => {
      if (details.seekTime !== undefined) client.send({ type: "seek", positionMs: Math.round(details.seekTime * 1000) });
    }],
  ];
  for (const [action, handler] of handlers) {
    try {
      session.setActionHandler(action, handler);
    } catch {
      // Unsupported action in this browser.
    }
  }
  return () => {
    for (const [action] of handlers) {
      try {
        session.setActionHandler(action, null);
      } catch {
        // Ignore.
      }
    }
    session.metadata = null;
  };
}

export function updateMediaSession(item: QueueItem | undefined, pb: Playback | null, serverNow: number): void {
  if (!("mediaSession" in navigator)) return;
  const session = navigator.mediaSession;
  // YouTube's embed manages its own session; only file items get ours.
  if (!item || !pb || item.kind === "youtube") {
    session.metadata = null;
    session.playbackState = "none";
    return;
  }
  const artwork = item.artUrl ? [{ src: new URL(item.artUrl, location.href).href }] : [];
  session.metadata = new MediaMetadata({
    title: item.title,
    artist: item.artist ?? "",
    album: item.album ?? "",
    artwork,
  });
  session.playbackState = pb.state === "playing" ? "playing" : "paused";
  if (item.durationMs && session.setPositionState) {
    const duration = item.durationMs / 1000;
    try {
      session.setPositionState({
        duration,
        playbackRate: 1,
        position: Math.min(duration, effectivePositionAt(pb, serverNow, item.durationMs) / 1000),
      });
    } catch {
      // Invalid state during transitions; the next update fixes it.
    }
  }
}
