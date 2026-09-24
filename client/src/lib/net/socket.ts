import type { ClientMessage, ServerMessage } from "@listening-room/shared";

const MIN_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 10_000;

/** A WebSocket that reconnects with exponential backoff (0.5 s up to 10 s). */
export class ReconnectingSocket {
  onOpen: () => void = () => {};
  /** Called with the close code. Returning false stops reconnecting. */
  onClose: (code: number) => boolean | void = () => {};
  onMessage: (message: ServerMessage) => void = () => {};

  private ws: WebSocket | null = null;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(private readonly url: string) {}

  start(): void {
    this.stopped = false;
    window.addEventListener("online", this.reconnectNow);
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    window.removeEventListener("online", this.reconnectNow);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.ws?.close();
    this.ws = null;
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(message: ClientMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(message));
    return true;
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.onOpen();
    };
    ws.onmessage = (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      this.onMessage(message);
    };
    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.onClose(event.code) === false) {
        this.stop();
        return;
      }
      this.scheduleRetry();
    };
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    const delay = Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** this.attempt);
    this.attempt++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  /** The network came back: skip the rest of the backoff. */
  private reconnectNow = (): void => {
    if (this.ws || this.stopped) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.attempt = 0;
    this.connect();
  };
}

export function roomSocketUrl(roomId: string): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/ws/${encodeURIComponent(roomId)}`;
}
