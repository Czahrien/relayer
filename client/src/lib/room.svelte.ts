import {
  parseYouTubeUrl,
  type ActivityEntry,
  type AddPosition,
  type ClientMessage,
  type ListenerHealth,
  type RoomSnapshot,
  type ServerMessage,
} from "@listening-room/shared";
import { prepareFiles, type IngestRequest, type PreparedFile } from "./ingest/drop.js";
import { UploadQueue } from "./ingest/upload.js";
import { ReconnectingSocket, roomSocketUrl } from "./net/socket.js";
import { FilePlayer } from "./players/FilePlayer.js";
import { prefs } from "./storage.js";
import { ClockSync } from "./sync/clock.js";
import { SyncEngine } from "./sync/engine.js";
import { toast } from "./toasts.svelte.js";

const ACTIVITY_LIMIT = 50;
const ACCEPT_TIMEOUT_MS = 20_000;

type Command = Exclude<ClientMessage, { type: "hello" | "ping" | "status" | "addFiles" }>;

/** Everything a joined client knows about its room, as reactive state. */
export class RoomClient {
  snapshot = $state.raw<RoomSnapshot | null>(null);
  presence = $state.raw<Record<string, ListenerHealth>>({});
  activity = $state.raw<ActivityEntry[]>([]);
  connected = $state(false);
  /** False until the first connection opens, so the banner doesn't flash on join. */
  hasConnected = $state(false);
  /** itemId → upload fraction, for this client's own uploads. */
  uploadProgress = $state.raw<Record<string, number>>({});
  volume = $state(prefs.volume);
  muted = $state(prefs.muted);

  readonly clock: ClockSync;
  readonly engine: SyncEngine;
  readonly filePlayer = new FilePlayer();

  private readonly socket: ReconnectingSocket;
  private readonly uploads: UploadQueue;
  private joinPending = true;
  private activityLogPending = true;
  private tempCounter = 0;
  private readonly pendingAccepts = new Map<string, (ids: Record<string, string>) => void>();
  /** itemId → snapshot rev when its upload was queued; see pruneUploads. */
  private readonly uploadRevs = new Map<string, number>();

  constructor(
    readonly roomId: string,
    readonly clientId: string,
    readonly name: string,
  ) {
    this.socket = new ReconnectingSocket(roomSocketUrl(roomId));
    this.socket.onOpen = () => this.handleOpen();
    this.socket.onClose = () => this.handleClose();
    this.socket.onMessage = (message) => this.handleMessage(message);

    this.clock = new ClockSync((t0) => this.socket.send({ type: "ping", t0 }));
    this.engine = new SyncEngine({
      snapshot: () => this.snapshot,
      serverNow: () => this.clock.serverNow(),
      clockSynced: () => this.clock.synced,
      send: (message) => this.socket.send(message),
      file: this.filePlayer,
    });
    this.uploads = new UploadQueue(roomId, {
      onProgress: (itemId, fraction) => (this.uploadProgress = { ...this.uploadProgress, [itemId]: fraction }),
      onDone: (itemId) => {
        this.uploadRevs.delete(itemId);
        const { [itemId]: _, ...rest } = this.uploadProgress;
        this.uploadProgress = rest;
      },
      onError: (_itemId, message) => toast(message, "error"),
    });
    this.applyVolume();
  }

  /** Must be called synchronously inside the Join click (§6.7, §8). */
  unlockAudio(): void {
    this.filePlayer.unlock();
  }

  start(): void {
    this.socket.start();
    this.engine.start();
  }

  destroy(): void {
    this.engine.stop();
    this.clock.stop();
    this.socket.stop();
    this.uploads.abortAll();
    this.filePlayer.destroy();
  }

  serverNow(): number {
    return this.clock.serverNow();
  }

  /** Sends a room command; returns false (and tells the user) when disconnected. */
  send(message: Command): boolean {
    const sent = this.socket.send(message);
    if (!sent) toast("Not connected. Try again in a moment.", "error");
    return sent;
  }

  setVolume(volume: number): void {
    this.volume = Math.min(1, Math.max(0, volume));
    if (this.volume > 0) this.muted = false;
    prefs.volume = this.volume;
    prefs.muted = this.muted;
    this.applyVolume();
  }

  toggleMute(): void {
    this.muted = !this.muted;
    prefs.muted = this.muted;
    this.applyVolume();
  }

  // ---- Ingest ----

  /** The single entry point for drops, pastes, and pickers (§7). */
  async ingest(request: IngestRequest, position: AddPosition = "end"): Promise<void> {
    let rejectedLinks = 0;
    for (const link of request.links) {
      if (parseYouTubeUrl(link)) this.send({ type: "addYoutube", url: link, position });
      else rejectedLinks++;
    }
    if (rejectedLinks > 0) toast("Only YouTube links are supported.", "error");

    const skipped = request.skipped;
    const skippedText = skipped > 0 ? `skipped ${skipped} non-audio ${skipped === 1 ? "file" : "files"}` : "";
    if (request.files.length === 0) {
      if (skipped > 0) toast(`No audio files found; ${skippedText}.`, "error");
      return;
    }
    if (!this.socket.isOpen) {
      toast("Not connected. Try again in a moment.", "error");
      return;
    }

    const prepared = await prepareFiles(request.files);
    let ids: Record<string, string>;
    const tempIds = prepared.map(() => `t${++this.tempCounter}`);
    try {
      ids = await this.addFiles(prepared, tempIds, position);
    } catch {
      toast("The server didn't accept the files. Try again.", "error");
      return;
    }
    const rev = this.snapshot?.rev ?? 0;
    const jobs = prepared.flatMap((p, i) => {
      const itemId = ids[tempIds[i]!];
      if (!itemId) return [];
      this.uploadRevs.set(itemId, rev);
      return [{ itemId, file: p.file }];
    });
    this.uploads.enqueue(jobs);

    const count = jobs.length;
    const added = `Added ${count} ${count === 1 ? "track" : "tracks"}`;
    toast(skippedText ? `${added}, ${skippedText}.` : `${added}.`);
  }

  private addFiles(files: PreparedFile[], tempIds: string[], position: AddPosition): Promise<Record<string, string>> {
    return new Promise((resolve, reject) => {
      const key = tempIds[0]!;
      const timer = setTimeout(() => {
        this.pendingAccepts.delete(key);
        reject(new Error("timeout"));
      }, ACCEPT_TIMEOUT_MS);
      this.pendingAccepts.set(key, (ids) => {
        clearTimeout(timer);
        resolve(ids);
      });
      const sent = this.socket.send({
        type: "addFiles",
        position,
        files: files.map((f, i) => ({
          tempId: tempIds[i]!,
          title: f.title,
          artist: f.artist,
          album: f.album,
          discNo: f.discNo,
          trackNo: f.trackNo,
        })),
      });
      if (!sent) {
        clearTimeout(timer);
        this.pendingAccepts.delete(key);
        reject(new Error("disconnected"));
      }
    });
  }

  /** Aborts uploads whose items were removed or cleared (§9). */
  private pruneUploads(snap: RoomSnapshot): void {
    for (const itemId of this.uploads.ids()) {
      // Skip snapshots from before the item existed.
      if (snap.rev <= (this.uploadRevs.get(itemId) ?? 0)) continue;
      const item = snap.items.find((i) => i.id === itemId);
      if (!item || item.status !== "uploading") this.uploads.abort(itemId);
    }
  }

  // ---- Connection ----

  private applyVolume(): void {
    this.filePlayer.setVolume(this.muted ? 0 : this.volume);
  }

  private handleOpen(): void {
    this.connected = true;
    this.hasConnected = true;
    this.joinPending = true;
    this.activityLogPending = true;
    this.socket.send({ type: "hello", clientId: this.clientId, name: this.name });
    this.clock.start();
  }

  private handleClose(): void {
    // Keep playing from the last known timeline; the clock offset stays valid.
    this.connected = false;
    this.clock.stop();
  }

  private handleMessage(message: ServerMessage): void {
    switch (message.type) {
      case "snapshot":
        // The first snapshot after (re)joining always wins: a restarted server starts rev over.
        if (!this.joinPending && this.snapshot && message.snapshot.rev < this.snapshot.rev) return;
        this.joinPending = false;
        this.snapshot = message.snapshot;
        this.pruneUploads(message.snapshot);
        this.engine.kick();
        break;
      case "pong":
        this.clock.handlePong(message.t0, message.serverTime);
        break;
      case "filesAccepted":
        for (const [key, resolve] of this.pendingAccepts) {
          if (key in message.ids) {
            this.pendingAccepts.delete(key);
            resolve(message.ids);
          }
        }
        break;
      case "presence":
        this.presence = Object.fromEntries(message.listeners.map((l) => [l.clientId, l]));
        break;
      case "activity":
        // The server sends its whole log on join; replace rather than duplicate.
        this.activity = this.activityLogPending
          ? message.entries
          : [...this.activity, ...message.entries].slice(-ACTIVITY_LIMIT);
        this.activityLogPending = false;
        break;
      case "error":
        toast(message.message, "error");
        break;
    }
  }
}
