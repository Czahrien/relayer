import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ServerMessage } from "@relayer/shared";
import { buildApp, type App } from "./app.js";

interface TestClient {
  ws: WebSocket;
  messages: ServerMessage[];
  send(message: unknown): void;
  next<T extends ServerMessage["type"]>(type: T): Promise<Extract<ServerMessage, { type: T }>>;
}

describe("WebSocket protocol", () => {
  let dataDir: string;
  let ctx: App;
  let base: string;
  const clients: TestClient[] = [];

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lr-ws-"));
    ctx = await buildApp(
      { port: 0, dataDir, maxUploadBytes: 1024 * 1024, roomIdleTtlMs: 60_000, createRoomOnJoin: true, libraryRescanMs: 3_600_000, maxRoomBytes: Number.POSITIVE_INFINITY },
      { youtube: async (url) => ({ youtubeId: "dQw4w9WgXcQ", title: `Video ${url.length}` }) },
    );
    const address = await ctx.app.listen({ port: 0, host: "127.0.0.1" });
    base = address.replace("http", "ws");
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) c.ws.close();
    await ctx.app.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  async function connect(roomId = "room1"): Promise<TestClient> {
    const ws = new WebSocket(`${base}/ws/${roomId}`);
    const messages: ServerMessage[] = [];
    const waiters: (() => void)[] = [];
    ws.onmessage = (event) => {
      messages.push(JSON.parse(String(event.data)) as ServerMessage);
      for (const wake of waiters.splice(0)) wake();
    };
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });
    // Each message type is consumed in order, independently of the others.
    const consumed = new Set<ServerMessage>();
    const client: TestClient = {
      ws,
      messages,
      send: (message) => ws.send(typeof message === "string" ? message : JSON.stringify(message)),
      async next(type) {
        for (;;) {
          const message = messages.find((m) => m.type === type && !consumed.has(m));
          if (message) {
            consumed.add(message);
            return message as never;
          }
          await new Promise<void>((resolve) => waiters.push(resolve));
        }
      },
    };
    clients.push(client);
    return client;
  }

  it("rejects commands before hello, and malformed messages, without disconnecting", async () => {
    const c = await connect();
    c.send({ type: "play" });
    expect((await c.next("error")).message).toMatch(/hello/);
    c.send("{not json");
    expect((await c.next("error")).message).toMatch(/JSON/);
    c.send({ type: "hello", clientId: "c1", name: "Ann" });
    const { snapshot } = await c.next("snapshot");
    expect(snapshot.listeners).toEqual([{ clientId: "c1", name: "Ann" }]);
    c.send({ type: "jump", itemId: "nope" });
    expect((await c.next("error")).message).toMatch(/no longer/);
    c.send({ type: "move", itemId: 5 });
    expect((await c.next("error")).message).toMatch(/Invalid/);
    c.send({ type: "ping", t0: 123 });
    const pong = await c.next("pong");
    expect(pong.t0).toBe(123);
    expect(ws(c)).toBe(WebSocket.OPEN);
  });

  it("broadcasts snapshots and activity to everyone in the room", async () => {
    const a = await connect();
    a.send({ type: "hello", clientId: "a", name: "Ann" });
    await a.next("snapshot");
    const b = await connect();
    b.send({ type: "hello", clientId: "b", name: "Ben" });
    await b.next("snapshot");

    a.send({ type: "addFiles", position: "end", files: [{ tempId: "t1", title: "One" }] });
    const accepted = await a.next("filesAccepted");
    expect(Object.keys(accepted.ids)).toEqual(["t1"]);

    let snap = (await b.next("snapshot")).snapshot;
    while (snap.items.length === 0) snap = (await b.next("snapshot")).snapshot;
    expect(snap.items[0]).toMatchObject({ id: accepted.ids.t1, status: "uploading", addedBy: "Ann" });
    expect(snap.playback?.state).toBe("waiting");
    expect((await b.next("activity")).entries).toEqual([]); // the (empty) log sent on join
    expect((await b.next("activity")).entries).toMatchObject([{ by: "Ann", text: "added “One”" }]);

    b.send({ type: "addYoutube", url: "https://youtu.be/dQw4w9WgXcQ", position: "next" });
    snap = (await a.next("snapshot")).snapshot;
    while (snap.items.length < 2) snap = (await a.next("snapshot")).snapshot;
    expect(snap.items.map((i) => i.kind)).toEqual(["file", "youtube"]);
  });

  it("sends the activity log on join", async () => {
    const a = await connect();
    a.send({ type: "hello", clientId: "a", name: "Ann" });
    await a.next("snapshot");
    a.send({ type: "addYoutube", url: "https://youtu.be/dQw4w9WgXcQ", position: "end" });
    await a.next("activity"); // the join log
    await a.next("activity"); // the add
    const b = await connect();
    b.send({ type: "hello", clientId: "b", name: "Ben" });
    const log = await b.next("activity");
    expect(log.entries.map((e) => e.text)).toContain("added “Video 28”");
  });

  it("closes sockets for invalid room IDs", async () => {
    const ws = new WebSocket(`${base}/ws/${encodeURIComponent("bad room!")}`);
    const code = await new Promise<number>((resolve) => (ws.onclose = (event) => resolve(event.code)));
    expect(code).toBe(1008);
  });

  function ws(c: TestClient): number {
    return c.ws.readyState;
  }
});
