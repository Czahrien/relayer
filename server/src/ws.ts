import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { parseYouTubePlaylistUrl, parseYouTubeUrl, type ClientMessage, type ServerMessage } from "@relayer/shared";
import type { Library } from "./library/library.js";
import type { MediaStore } from "./media.js";
import { CommandError, type Actor, type Room } from "./room.js";
import { RoomRegistry } from "./rooms.js";
import { parseClientMessage } from "./validate.js";
import type { YoutubeResolver } from "./youtube.js";
import type { YouTubeData, YouTubeVideo } from "./youtubeApi.js";

/** For listeners, not admins: the README explains YOUTUBE_API_KEY. */
const PLAYLISTS_UNAVAILABLE = "This server can't open YouTube playlists. Add the songs one link at a time.";

function toItemInfo(video: YouTubeVideo) {
  return {
    youtubeId: video.youtubeId,
    title: video.title,
    artist: video.channel,
    artUrl: video.thumbnail,
    durationMs: video.durationMs,
    error: video.unplayable,
  };
}

const HEARTBEAT_MS = 30_000;
const PRESENCE_THROTTLE_MS = 1000;

interface Connection {
  socket: WebSocket;
  actor: Actor | null; // null until `hello`
  alive: boolean;
  /** Chat rate limit: a bucket of messages that refills over time. */
  chat: { tokens: number; refilledAt: number };
}

/** Bursts of up to 5 messages, then one every 2 seconds. */
const CHAT_BURST = 5;
const CHAT_REFILL_MS = 2000;

/** Takes one message from the connection's allowance; false when it's used up. */
function allowChat(conn: Connection, now: number): boolean {
  const refill = Math.floor((now - conn.chat.refilledAt) / CHAT_REFILL_MS);
  if (refill > 0) {
    conn.chat.tokens = Math.min(CHAT_BURST, conn.chat.tokens + refill);
    conn.chat.refilledAt = conn.chat.tokens === CHAT_BURST ? now : conn.chat.refilledAt + refill * CHAT_REFILL_MS;
  }
  if (conn.chat.tokens === 0) return false;
  conn.chat.tokens--;
  return true;
}

/** Tracks sockets per room and fans out broadcasts. */
export class Hub {
  private readonly connections = new Map<string, Set<Connection>>();
  private readonly pendingSnapshots = new Set<Room>();
  private readonly presenceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  add(roomId: string, conn: Connection): void {
    let set = this.connections.get(roomId);
    if (!set) this.connections.set(roomId, (set = new Set()));
    set.add(conn);
  }

  delete(roomId: string, conn: Connection): void {
    const set = this.connections.get(roomId);
    if (!set) return;
    set.delete(conn);
    if (set.size === 0) this.connections.delete(roomId);
  }

  all(): Iterable<Connection> {
    return [...this.connections.values()].flatMap((set) => [...set]);
  }

  broadcast(roomId: string, message: ServerMessage): void {
    const set = this.connections.get(roomId);
    if (!set) return;
    const data = JSON.stringify(message);
    for (const conn of set) if (conn.actor) sendRaw(conn.socket, data);
  }

  /** Coalesces every change made while handling one command into one snapshot. */
  scheduleSnapshot(room: Room): void {
    if (this.pendingSnapshots.has(room)) return;
    this.pendingSnapshots.add(room);
    queueMicrotask(() => {
      this.pendingSnapshots.delete(room);
      this.broadcast(room.id, { type: "snapshot", snapshot: room.snapshot() });
    });
  }

  schedulePresence(room: Room): void {
    if (this.presenceTimers.has(room.id)) return;
    this.presenceTimers.set(
      room.id,
      setTimeout(() => {
        this.presenceTimers.delete(room.id);
        this.broadcast(room.id, { type: "presence", listeners: room.presence() });
      }, PRESENCE_THROTTLE_MS),
    );
  }

  closeAll(): void {
    for (const conn of this.all()) conn.socket.close(1001, "Server shutting down");
    for (const timer of this.presenceTimers.values()) clearTimeout(timer);
    this.presenceTimers.clear();
  }
}

function sendRaw(socket: WebSocket, data: string): void {
  if (socket.readyState === socket.OPEN) socket.send(data);
}

function send(socket: WebSocket, message: ServerMessage): void {
  sendRaw(socket, JSON.stringify(message));
}

/** Close code telling the client the room doesn't exist, so it stops reconnecting. */
export const ROOM_NOT_FOUND_CLOSE = 4404;

export interface WebSocketOptions {
  /** Whether `hello` for an unknown room ID creates the room (§5). */
  createRoomOnJoin: boolean;
  /** The server library, or null when LIBRARY_DIR is unset (§10). */
  library: Library | null;
  /** The YouTube Data API, or null without YOUTUBE_API_KEY (§14). */
  youtubeData: YouTubeData | null;
  media: MediaStore;
}

export function registerWebSocket(
  app: FastifyInstance,
  registry: RoomRegistry,
  hub: Hub,
  resolveYoutube: YoutubeResolver,
  { createRoomOnJoin, library, media, youtubeData }: WebSocketOptions,
): void {
  const heartbeat = setInterval(() => {
    for (const conn of hub.all()) {
      if (!conn.alive) {
        conn.socket.terminate();
        continue;
      }
      conn.alive = false;
      conn.socket.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();
  app.addHook("onClose", async () => clearInterval(heartbeat));

  app.get<{ Params: { roomId: string } }>("/ws/:roomId", { websocket: true }, (socket, request) => {
    const { roomId } = request.params;
    if (!RoomRegistry.isValidId(roomId)) {
      socket.close(1008, "Invalid room");
      return;
    }
    const conn: Connection = {
      socket,
      actor: null,
      alive: true,
      chat: { tokens: CHAT_BURST, refilledAt: Date.now() },
    };
    hub.add(roomId, conn);

    socket.on("pong", () => (conn.alive = true));
    socket.on("close", () => {
      hub.delete(roomId, conn);
      if (conn.actor) registry.get(roomId)?.leave(conn.actor.clientId);
    });
    socket.on("message", (data, isBinary) => {
      conn.alive = true;
      if (isBinary) return send(socket, { type: "error", message: "Binary messages are not supported." });
      let message: ClientMessage;
      try {
        message = parseClientMessage(data.toString());
      } catch (err) {
        return send(socket, { type: "error", message: errorMessage(err) });
      }
      handle(roomId, conn, message).catch((err: unknown) => {
        if (!(err instanceof CommandError)) request.log.error({ err, type: message.type }, "command failed");
        send(socket, { type: "error", message: errorMessage(err) });
      });
    });
  });

  async function handle(roomId: string, conn: Connection, message: ClientMessage): Promise<void> {
    const { socket } = conn;
    if (message.type === "ping") {
      return send(socket, { type: "pong", t0: message.t0, serverTime: Date.now() });
    }
    if (message.type === "hello") {
      if (conn.actor) throw new CommandError("Already joined.");
      const room = createRoomOnJoin ? registry.getOrCreate(roomId) : registry.get(roomId);
      if (!room) {
        socket.close(ROOM_NOT_FOUND_CLOSE, "Room not found");
        return;
      }
      conn.actor = { clientId: message.clientId, name: message.name };
      room.join(message.clientId, message.name);
      send(socket, { type: "snapshot", snapshot: room.snapshot() });
      send(socket, { type: "activity", entries: room.activity() });
      send(socket, { type: "presence", listeners: room.presence() });
      return;
    }

    const actor = conn.actor;
    if (!actor) throw new CommandError("Send hello first.");
    // A room is swept only when empty, and this connection is a listener.
    const room = registry.get(roomId);
    if (!room) throw new CommandError("This room doesn't exist.");

    switch (message.type) {
      case "addYoutube": {
        const listId = parseYouTubePlaylistUrl(message.url);
        if (listId) {
          if (!youtubeData) throw new CommandError(PLAYLISTS_UNAVAILABLE);
          const playlist = await youtubeData.playlist(listId);
          if (playlist.videos.length === 0) throw new CommandError("None of that playlist's videos can play here.");
          room.addYoutubeVideos(actor, playlist.videos.map(toItemInfo), message.position, playlist.title);
          if (playlist.skipped > 0) {
            const n = playlist.skipped;
            send(socket, {
              type: "notice",
              message: `Left out ${n} ${n === 1 ? "video" : "videos"} from that playlist that can't play here.`,
            });
          }
          return;
        }
        // With a key, the API gives the duration up front and says whether it
        // can play; without one (or if the API fails), oEmbed covers the basics.
        const id = parseYouTubeUrl(message.url);
        const video = id && youtubeData ? await youtubeData.video(id).catch(() => undefined) : undefined;
        room.addYoutube(actor, video ? toItemInfo(video) : await resolveYoutube(message.url), message.position);
        return;
      }
      case "addFiles": {
        const ids = room.addFiles(actor, message.files, message.position);
        return send(socket, { type: "filesAccepted", ids });
      }
      case "addLibrary": {
        if (!library) throw new CommandError("The library isn't enabled.");
        const tracks = message.trackIds.map((id) => library.track(id));
        if (tracks.some((t) => !t)) throw new CommandError("Some of those tracks are no longer in the library.");
        const resolved = tracks.map((track) => ({ track: track!, art: track!.albumId ? library.albumArt(track!.albumId) : undefined }));
        const items = room.addLibrary(
          actor,
          resolved.map(({ track, art }) => ({ ...track, hasArt: !!art })),
          message.position,
        );
        // Reference the library files; the snapshot goes out after this handler,
        // so the records exist before any client asks for them.
        items.forEach((item, i) => {
          const { track, art } = resolved[i]!;
          media.set(roomId, item.id, {
            mime: track.mime,
            library: { source: library.source, path: track.path },
            art: art && { path: art.file, mime: art.mime, owned: false },
          });
        });
        return;
      }
      case "play":
        return room.play(actor);
      case "pause":
        return room.pause(actor);
      case "seek":
        return room.seek(actor, message.positionMs);
      case "next":
        return room.next(actor);
      case "previous":
        return room.previous(actor);
      case "restart":
        return room.restart(actor);
      case "jump":
        return room.jump(actor, message.itemId);
      case "playNext":
        return room.playNext(actor, message.itemId);
      case "move":
        return room.move(actor, message.itemId, message.toIndex);
      case "remove":
        return room.remove(actor, message.itemId);
      case "clear":
        return room.clear(actor);
      case "clearPlayed":
        return room.clearPlayed(actor);
      case "chat":
        if (!allowChat(conn, Date.now())) throw new CommandError("You're sending messages too quickly. Wait a moment.");
        return room.say(actor, message.text);
      case "reportDuration":
        return room.reportDuration(message.itemId, message.durationMs);
      case "ended":
        return room.ended(message.itemId);
      case "itemError":
        return room.itemError(message.itemId, message.message);
      case "status":
        return room.setHealth(actor.clientId, message.driftMs, message.state);
    }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof CommandError ? err.message : "Something went wrong on the server.";
}
