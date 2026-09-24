import { nanoid } from "nanoid";
import {
  END_GRACE_MS,
  ENDED_TOLERANCE_MS,
  NEW_TRACK_LEAD_MS,
  PREVIOUS_RESTART_THRESHOLD_MS,
  RESUME_LEAD_MS,
  effectivePositionAt,
  positionAt,
  type ActivityEntry,
  type AddPosition,
  type FileDescriptor,
  type ListenerHealth,
  type ListenerSyncState,
  type Playback,
  type QueueItem,
  type RoomSnapshot,
} from "@listening-room/shared";

/** A command the room refuses. The socket layer turns it into an `error` reply. */
export class CommandError extends Error {}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface RoomHooks {
  /** State changed and `rev` was bumped; broadcast a snapshot. */
  onChange?(room: Room): void;
  onActivity?(entry: ActivityEntry): void;
  /** Listener sync health changed (does not bump `rev`). */
  onPresence?(room: Room): void;
  /** Items left the queue; their media can be discarded. */
  onItemsRemoved?(items: QueueItem[]): void;
}

export interface Actor {
  clientId: string;
  name: string;
}

export interface YoutubeItemInfo {
  youtubeId: string;
  title: string;
  artist?: string;
  artUrl?: string;
  /** Set when the video is known to be unplayable before anyone tries it. */
  error?: string;
}

/** Metadata the server learned from an uploaded file. Defined fields win. */
export type UploadedMetadata = Partial<
  Pick<QueueItem, "title" | "artist" | "album" | "discNo" | "trackNo" | "durationMs" | "artUrl">
>;

interface ListenerRecord {
  name: string;
  connections: number;
  health: { driftMs: number | null; state: ListenerSyncState };
}

const ACTIVITY_LIMIT = 50;
/** How long a departed uploader has to come back before their pending uploads fail. */
export const UPLOAD_ABANDON_MS = 20_000;
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;

export class Room {
  readonly id: string;
  private items: QueueItem[] = [];
  private currentIndex = 0;
  private playback: Playback | null = null;
  private rev = 0;
  private readonly listeners = new Map<string, ListenerRecord>();
  private readonly activityLog: ActivityEntry[] = [];
  /** itemId → clientId of the uploader, for items still uploading. */
  private readonly uploaders = new Map<string, string>();
  private readonly abandonTimers = new Map<string, unknown>();
  private endTimer: unknown = null;
  /** Server time when the last listener left, or null while anyone is here. */
  emptySince: number | null;

  constructor(
    id: string,
    private readonly hooks: RoomHooks = {},
    private readonly clock: Clock = systemClock,
  ) {
    this.id = id;
    this.emptySince = clock.now();
  }

  // ---- Reading state ----

  snapshot(): RoomSnapshot {
    return {
      roomId: this.id,
      rev: this.rev,
      items: this.items.map((item) => ({ ...item })),
      currentIndex: this.currentIndex,
      playback: this.playback ? { ...this.playback } : null,
      listeners: [...this.listeners].map(([clientId, l]) => ({ clientId, name: l.name })),
    };
  }

  presence(): ListenerHealth[] {
    return [...this.listeners].map(([clientId, l]) => ({ clientId, ...l.health }));
  }

  activity(): ActivityEntry[] {
    return [...this.activityLog];
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  getItem(itemId: string): QueueItem | undefined {
    return this.items.find((item) => item.id === itemId);
  }

  // ---- Listeners ----

  join(clientId: string, name: string): void {
    const existing = this.listeners.get(clientId);
    if (existing) {
      existing.connections++;
      existing.name = name;
    } else {
      this.listeners.set(clientId, { name, connections: 1, health: { driftMs: null, state: "loading" } });
    }
    this.emptySince = null;
    const abandon = this.abandonTimers.get(clientId);
    if (abandon !== undefined) {
      this.clock.clearTimeout(abandon);
      this.abandonTimers.delete(clientId);
    }
    this.commit();
  }

  leave(clientId: string): void {
    const listener = this.listeners.get(clientId);
    if (!listener) return;
    if (--listener.connections > 0) return;
    this.listeners.delete(clientId);
    if (this.listeners.size === 0) this.emptySince = this.clock.now();
    if ([...this.uploaders.values()].includes(clientId)) {
      this.abandonTimers.set(
        clientId,
        this.clock.setTimeout(() => this.abandonUploads(clientId), UPLOAD_ABANDON_MS),
      );
    }
    this.commit();
  }

  setHealth(clientId: string, driftMs: number | null, state: ListenerSyncState): void {
    const listener = this.listeners.get(clientId);
    if (!listener) return;
    listener.health = { driftMs, state };
    this.hooks.onPresence?.(this);
  }

  // ---- Adding items ----

  /** Creates `uploading` items and returns tempId → itemId. */
  addFiles(actor: Actor, files: FileDescriptor[], position: AddPosition): Record<string, string> {
    const ids: Record<string, string> = {};
    const now = this.clock.now();
    const created = files.map((file): QueueItem => {
      const id = nanoid(12);
      ids[file.tempId] = id;
      this.uploaders.set(id, actor.clientId);
      return {
        id,
        kind: "file",
        status: "uploading",
        mediaUrl: `/media/${this.id}/${id}`,
        title: file.title,
        artist: file.artist,
        album: file.album,
        discNo: file.discNo,
        trackNo: file.trackNo,
        addedBy: actor.name,
        addedAt: now,
      };
    });
    this.insert(created, position);

    const first = created[0];
    if (created.length === 1 && first) {
      this.log(actor.name, `added “${first.title}”`);
    } else {
      const albums = new Set(created.map((item) => item.album));
      const [album] = albums;
      const from = albums.size === 1 && album ? ` from “${album}”` : "";
      this.log(actor.name, `added ${created.length} tracks${from}`);
    }
    this.commit();
    return ids;
  }

  addYoutube(actor: Actor, info: YoutubeItemInfo, position: AddPosition): QueueItem {
    const item: QueueItem = {
      id: nanoid(12),
      kind: "youtube",
      status: info.error ? "error" : "ready",
      error: info.error,
      youtubeId: info.youtubeId,
      title: info.title,
      artist: info.artist,
      artUrl: info.artUrl,
      addedBy: actor.name,
      addedAt: this.clock.now(),
    };
    this.insert([item], position);
    this.log(actor.name, `added “${item.title}”`);
    this.commit();
    return item;
  }

  // ---- Transport ----

  play(actor: Actor): void {
    const pb = this.playback;
    if (!pb || pb.state !== "paused") return;
    this.playback = { ...pb, state: "playing", anchorTime: this.clock.now() + RESUME_LEAD_MS };
    this.log(actor.name, "resumed playback");
    this.commit();
  }

  pause(actor: Actor): void {
    const pb = this.playback;
    if (!pb || pb.state !== "playing") return;
    const now = this.clock.now();
    this.playback = {
      ...pb,
      state: "paused",
      anchorPosMs: effectivePositionAt(pb, now, this.current()?.durationMs),
      anchorTime: now,
    };
    this.log(actor.name, "paused");
    this.commit();
  }

  seek(_actor: Actor, positionMs: number): void {
    if (!this.seekTo(positionMs)) return;
    this.commit();
  }

  restart(actor: Actor): void {
    const item = this.current();
    if (!item || !this.seekTo(0)) return;
    this.log(actor.name, `restarted “${item.title}”`);
    this.commit();
  }

  next(actor: Actor): void {
    const item = this.current();
    if (!item) return;
    this.startAt(this.currentIndex + 1);
    this.log(actor.name, `skipped “${item.title}”`);
    this.commit();
  }

  previous(actor: Actor): void {
    const now = this.clock.now();
    const item = this.current();
    const pb = this.playback;
    if (!item || !pb) {
      const index = this.lastPlayableBefore(this.items.length);
      if (index < 0) return;
      this.startAt(index);
    } else if (effectivePositionAt(pb, now, item.durationMs) > PREVIOUS_RESTART_THRESHOLD_MS) {
      if (!this.seekTo(0)) return;
    } else {
      const index = this.lastPlayableBefore(this.currentIndex);
      if (index >= 0) this.startAt(index);
      else if (!this.seekTo(0)) return;
    }
    this.log(actor.name, "went back");
    this.commit();
  }

  jump(actor: Actor, itemId: string): void {
    const index = this.indexOf(itemId);
    const item = this.items[index]!;
    if (item.status === "error") throw new CommandError("That item can't be played.");
    this.startAt(index);
    this.log(actor.name, `jumped to “${item.title}”`);
    this.commit();
  }

  // ---- Queue editing ----

  /** Moves an item to just after the current one; from idle, it starts playing. */
  playNext(actor: Actor, itemId: string): void {
    const index = this.indexOf(itemId);
    const item = this.items[index]!;
    if (this.isIdle()) {
      this.items.splice(index, 1);
      this.items.push(item);
      this.startAt(this.items.length - 1);
    } else {
      if (index === this.currentIndex) return;
      this.items.splice(index, 1);
      if (index < this.currentIndex) this.currentIndex--;
      this.items.splice(this.currentIndex + 1, 0, item);
    }
    this.log(actor.name, `will play “${item.title}” next`);
    this.commit();
  }

  move(actor: Actor, itemId: string, toIndex: number): void {
    const from = this.indexOf(itemId);
    if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex >= this.items.length) {
      throw new CommandError("That position is out of range.");
    }
    if (from === toIndex) return;
    const currentId = this.current()?.id;
    const [item] = this.items.splice(from, 1);
    this.items.splice(toIndex, 0, item!);
    this.currentIndex = currentId === undefined ? this.items.length : this.indexOf(currentId);
    this.log(actor.name, `moved “${item!.title}”`);
    this.commit();
  }

  remove(actor: Actor, itemId: string): void {
    const index = this.indexOf(itemId);
    const wasCurrent = !this.isIdle() && index === this.currentIndex;
    const [item] = this.items.splice(index, 1);
    if (index < this.currentIndex) this.currentIndex--;
    if (wasCurrent) this.startAt(this.currentIndex);
    this.uploaders.delete(itemId);
    this.hooks.onItemsRemoved?.([item!]);
    this.log(actor.name, `removed “${item!.title}”`);
    this.commit();
  }

  clear(actor: Actor): void {
    if (this.items.length === 0) return;
    const removed = this.items;
    this.items = [];
    this.currentIndex = 0;
    this.playback = null;
    this.uploaders.clear();
    this.hooks.onItemsRemoved?.(removed);
    this.log(actor.name, "cleared the queue");
    this.commit();
  }

  // ---- Reports from players ----

  reportDuration(itemId: string, durationMs: number): void {
    const item = this.getItem(itemId);
    if (!item || item.durationMs !== undefined) return;
    if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > MAX_DURATION_MS) return;
    item.durationMs = Math.round(durationMs);
    this.commit();
  }

  ended(itemId: string): void {
    const item = this.current();
    const pb = this.playback;
    if (!item || !pb || item.id !== itemId || pb.state !== "playing") return;
    if (item.durationMs !== undefined) {
      const pos = effectivePositionAt(pb, this.clock.now(), item.durationMs);
      if (pos < item.durationMs - ENDED_TOLERANCE_MS) return;
    }
    this.startAt(this.currentIndex + 1);
    this.commit();
  }

  itemError(itemId: string, message: string): void {
    const item = this.getItem(itemId);
    if (!item || item.status !== "ready") return;
    this.markError(item, message);
    this.log("", `couldn't play “${item.title}”: ${message}`);
    this.commit();
  }

  // ---- Uploads ----

  /** The item if it is a file still waiting for its upload, else undefined. */
  pendingUpload(itemId: string): QueueItem | undefined {
    const item = this.getItem(itemId);
    return item && item.kind === "file" && item.status === "uploading" ? item : undefined;
  }

  completeUpload(itemId: string, meta: UploadedMetadata): boolean {
    const item = this.pendingUpload(itemId);
    if (!item) return false;
    for (const [key, value] of Object.entries(meta)) {
      if (value !== undefined && value !== "") (item as unknown as Record<string, unknown>)[key] = value;
    }
    item.status = "ready";
    this.uploaders.delete(itemId);
    if (this.current()?.id === itemId && this.playback?.state === "waiting") {
      this.startAt(this.currentIndex);
    }
    this.commit();
    return true;
  }

  failUpload(itemId: string, message: string): void {
    const item = this.pendingUpload(itemId);
    if (!item) return;
    this.uploaders.delete(itemId);
    this.markError(item, message);
    this.log("", `couldn't add “${item.title}”: ${message}`);
    this.commit();
  }

  dispose(): void {
    if (this.endTimer !== null) this.clock.clearTimeout(this.endTimer);
    for (const handle of this.abandonTimers.values()) this.clock.clearTimeout(handle);
    this.endTimer = null;
    this.abandonTimers.clear();
  }

  // ---- Internals ----

  private isIdle(): boolean {
    return this.currentIndex >= this.items.length;
  }

  private current(): QueueItem | undefined {
    return this.playback ? this.items[this.currentIndex] : undefined;
  }

  private indexOf(itemId: string): number {
    const index = this.items.findIndex((item) => item.id === itemId);
    if (index < 0) throw new CommandError("That item is no longer in the queue.");
    return index;
  }

  private lastPlayableBefore(index: number): number {
    for (let i = index - 1; i >= 0; i--) if (this.items[i]!.status !== "error") return i;
    return -1;
  }

  private insert(newItems: QueueItem[], position: AddPosition): void {
    const wasIdle = this.isIdle();
    const at = position === "next" && !wasIdle ? this.currentIndex + 1 : this.items.length;
    this.items.splice(at, 0, ...newItems);
    // From idle the pointer already sits at the old end: the first new item.
    if (wasIdle) this.startAt(this.currentIndex);
  }

  /** Makes the first playable item at or after `index` current, or goes idle. */
  private startAt(index: number): void {
    let i = index;
    while (i < this.items.length && this.items[i]!.status === "error") i++;
    this.currentIndex = i;
    const item = this.items[i];
    if (!item) {
      this.currentIndex = this.items.length;
      this.playback = null;
      return;
    }
    const now = this.clock.now();
    this.playback =
      item.status === "uploading"
        ? { itemId: item.id, state: "waiting", anchorPosMs: 0, anchorTime: now }
        : { itemId: item.id, state: "playing", anchorPosMs: 0, anchorTime: now + NEW_TRACK_LEAD_MS };
  }

  /** Seeks the current item. Returns false when there is nothing to seek. */
  private seekTo(positionMs: number): boolean {
    const pb = this.playback;
    const item = this.current();
    if (!pb || !item || pb.state === "waiting") return false;
    const max = item.durationMs ?? Number.POSITIVE_INFINITY;
    const target = Math.round(Math.min(Math.max(0, positionMs), max));
    const now = this.clock.now();
    this.playback =
      pb.state === "playing"
        ? { ...pb, anchorPosMs: target, anchorTime: now + RESUME_LEAD_MS }
        : { ...pb, anchorPosMs: target, anchorTime: now };
    return true;
  }

  private markError(item: QueueItem, message: string): void {
    item.status = "error";
    item.error = message;
    if (this.current()?.id === item.id) this.startAt(this.currentIndex);
  }

  private abandonUploads(clientId: string): void {
    this.abandonTimers.delete(clientId);
    let changed = false;
    for (const [itemId, uploader] of this.uploaders) {
      if (uploader !== clientId) continue;
      const item = this.pendingUpload(itemId);
      this.uploaders.delete(itemId);
      if (!item) continue;
      this.markError(item, "The upload was interrupted.");
      changed = true;
    }
    if (changed) this.commit();
  }

  private log(by: string, text: string): void {
    const entry = { at: this.clock.now(), by, text };
    this.activityLog.push(entry);
    if (this.activityLog.length > ACTIVITY_LIMIT) this.activityLog.shift();
    this.hooks.onActivity?.(entry);
  }

  private commit(): void {
    this.rev++;
    this.scheduleEnd();
    this.hooks.onChange?.(this);
  }

  /** Server-side advance when the current item's known duration runs out (§6.4). */
  private scheduleEnd(): void {
    if (this.endTimer !== null) {
      this.clock.clearTimeout(this.endTimer);
      this.endTimer = null;
    }
    const pb = this.playback;
    const durationMs = this.current()?.durationMs;
    if (!pb || pb.state !== "playing" || durationMs === undefined) return;
    const fireAt = pb.anchorTime + (durationMs - pb.anchorPosMs) + END_GRACE_MS;
    this.endTimer = this.clock.setTimeout(
      () => {
        this.endTimer = null;
        const now = this.clock.now();
        if (this.playback?.itemId !== pb.itemId || this.playback.state !== "playing") return;
        if (positionAt(this.playback, now) >= durationMs) {
          this.startAt(this.currentIndex + 1);
          this.commit();
        } else {
          this.scheduleEnd();
        }
      },
      Math.max(0, fireAt - this.clock.now()),
    );
  }
}
