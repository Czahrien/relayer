// Wire types shared by the server and the client. This file is the single
// source of truth for the protocol (see SPEC §4 and §5).

export type ItemKind = "file" | "youtube" | "library"; // "library" is reserved; not built in this slice
export type ItemStatus = "uploading" | "ready" | "error";

export interface QueueItem {
  id: string;
  kind: ItemKind;
  status: ItemStatus;
  error?: string;

  // source
  mediaUrl?: string; // file: /media/:roomId/:itemId
  youtubeId?: string;

  // metadata
  title: string;
  artist?: string;
  album?: string;
  discNo?: number;
  trackNo?: number;
  artUrl?: string; // file: /media/:roomId/:itemId/art; youtube: thumbnail URL
  durationMs?: number; // may be unknown until a client reports it

  addedBy: string; // display name
  addedAt: number; // server epoch ms
}

export type PlaybackState = "playing" | "paused" | "waiting";

export interface Playback {
  itemId: string;
  state: PlaybackState; // waiting = current item is still uploading
  anchorPosMs: number; // playhead position at anchorTime
  anchorTime: number; // server epoch ms (may be slightly in the future)
}

export interface Listener {
  clientId: string;
  name: string;
}

export interface RoomSnapshot {
  roomId: string;
  rev: number; // increments on every state change
  items: QueueItem[];
  currentIndex: number; // 0..items.length; === items.length means idle
  playback: Playback | null; // null when idle
  listeners: Listener[];
}

export type AddPosition = "end" | "next";

export interface FileDescriptor {
  tempId: string;
  title: string;
  artist?: string;
  album?: string;
  discNo?: number;
  trackNo?: number;
}

/** What a client's player is doing, as reported in `status`. */
export type ListenerSyncState = "playing" | "paused" | "buffering" | "loading" | "idle";

export interface ListenerHealth {
  clientId: string;
  driftMs: number | null;
  state: ListenerSyncState;
}

export interface ActivityEntry {
  at: number; // server epoch ms
  by: string; // display name, or "" for the room itself
  text: string;
  /** "event" for things that happened ("added 3 tracks"), "message" for chat. */
  kind: "event" | "message";
}

// ---- Server library (SPEC §10) ----
// Responses carry IDs and metadata only, never file paths.

export interface LibraryTrackInfo {
  id: string;
  title: string;
  artist?: string;
  album?: string;
  albumId?: string;
  discNo?: number;
  trackNo?: number;
  year?: number;
  durationMs?: number;
  /** Whether the album has art, at /api/rooms/:roomId/library/albums/:albumId/art. */
  hasArt: boolean;
}

export interface LibraryAlbumInfo {
  id: string;
  title: string;
  /** The album artist, the shared artist of all tracks, or "Various Artists". */
  artist?: string;
  year?: number;
  trackCount: number;
  durationMs: number;
  hasArt: boolean;
}

export interface LibraryArtistInfo {
  name: string;
  albumCount: number;
  trackCount: number;
}

export interface LibrarySearchResult {
  artists: LibraryArtistInfo[];
  albums: LibraryAlbumInfo[];
  tracks: LibraryTrackInfo[];
}

export interface LibraryStatus {
  enabled: boolean;
  /** True while a scan runs; results cover what's indexed so far. */
  indexing: boolean;
  trackCount: number;
}

// ---- Client → server ----

export type ClientMessage =
  | { type: "hello"; clientId: string; name: string }
  | { type: "ping"; t0: number }
  | { type: "addYoutube"; url: string; position: AddPosition }
  | { type: "addFiles"; files: FileDescriptor[]; position: AddPosition }
  | { type: "addLibrary"; trackIds: string[]; position: AddPosition }
  | { type: "play" }
  | { type: "pause" }
  | { type: "seek"; positionMs: number }
  | { type: "next" }
  | { type: "previous" }
  | { type: "restart" }
  | { type: "jump"; itemId: string }
  | { type: "playNext"; itemId: string }
  | { type: "move"; itemId: string; toIndex: number }
  | { type: "remove"; itemId: string }
  | { type: "clear" }
  | { type: "clearPlayed" }
  | { type: "chat"; text: string }
  | { type: "reportDuration"; itemId: string; durationMs: number }
  | { type: "ended"; itemId: string }
  | { type: "itemError"; itemId: string; message: string }
  | { type: "status"; driftMs: number | null; state: ListenerSyncState };

export type ClientMessageType = ClientMessage["type"];

// ---- Server → client ----

export type ServerMessage =
  | { type: "snapshot"; snapshot: RoomSnapshot }
  | { type: "pong"; t0: number; serverTime: number }
  | { type: "filesAccepted"; ids: Record<string, string> }
  // Live entries arrive one at a time; on join the recent log arrives in one message.
  | { type: "activity"; entries: ActivityEntry[] }
  | { type: "presence"; listeners: ListenerHealth[] }
  | { type: "error"; message: string };

export const MAX_NAME_LENGTH = 40;
export const MAX_CHAT_LENGTH = 500;
/** Most library tracks one addLibrary may add (a large box set). */
export const MAX_LIBRARY_BATCH = 500;
export const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
