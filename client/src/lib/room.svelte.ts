import type {
  ActivityEntry,
  ClientMessage,
  ListenerHealth,
  RoomSnapshot,
  ServerMessage,
} from "@listening-room/shared";
import { ReconnectingSocket, roomSocketUrl } from "./net/socket.js";
import { toast } from "./toasts.svelte.js";

const ACTIVITY_LIMIT = 50;

/** Everything a joined client knows about its room, as reactive state. */
export class RoomClient {
  snapshot = $state.raw<RoomSnapshot | null>(null);
  presence = $state.raw<Record<string, ListenerHealth>>({});
  activity = $state.raw<ActivityEntry[]>([]);
  connected = $state(false);
  /** False until the first connection opens, so the banner doesn't flash on join. */
  hasConnected = $state(false);

  private readonly socket: ReconnectingSocket;
  private joinPending = true;
  private activityLogPending = true;

  constructor(
    readonly roomId: string,
    readonly clientId: string,
    readonly name: string,
  ) {
    this.socket = new ReconnectingSocket(roomSocketUrl(roomId));
    this.socket.onOpen = () => this.handleOpen();
    this.socket.onClose = () => (this.connected = false);
    this.socket.onMessage = (message) => this.handleMessage(message);
  }

  start(): void {
    this.socket.start();
  }

  destroy(): void {
    this.socket.stop();
  }

  /** Sends a command; returns false (and tells the user) when disconnected. */
  send(message: ClientMessage): boolean {
    const sent = this.socket.send(message);
    if (!sent && message.type !== "status" && message.type !== "ping") {
      toast("Not connected. Try again in a moment.", "error");
    }
    return sent;
  }

  private handleOpen(): void {
    this.connected = true;
    this.hasConnected = true;
    this.joinPending = true;
    this.activityLogPending = true;
    this.socket.send({ type: "hello", clientId: this.clientId, name: this.name });
  }

  private handleMessage(message: ServerMessage): void {
    switch (message.type) {
      case "snapshot":
        // The first snapshot after (re)joining always wins: a restarted server starts rev over.
        if (!this.joinPending && this.snapshot && message.snapshot.rev < this.snapshot.rev) return;
        this.joinPending = false;
        this.snapshot = message.snapshot;
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
      case "pong":
      case "filesAccepted":
        break;
    }
  }
}
