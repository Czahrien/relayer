import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type App } from "./app.js";
import { ROOM_NOT_FOUND_CLOSE } from "./ws.js";

let ctx: App | null = null;
let dataDir = "";

async function start(createRoomOnJoin: boolean): Promise<App> {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lr-app-"));
  ctx = await buildApp(
    { port: 0, dataDir, maxUploadBytes: 1024 * 1024, roomIdleTtlMs: 60_000, createRoomOnJoin, libraryRescanMs: 3_600_000, maxRoomBytes: Number.POSITIVE_INFINITY },
    { youtube: async () => ({ youtubeId: "x", title: "x" }) },
  );
  return ctx;
}

afterEach(async () => {
  await ctx?.app.close();
  ctx = null;
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe("room creation under /start", () => {
  it("creates a room from the start form and redirects to it", async () => {
    const { app, registry } = await start(false);
    const res = await app.inject({
      method: "POST",
      url: "/start",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "",
    });
    expect(res.statusCode).toBe(303);
    const roomId = /^\/r\/([a-z]+-[a-z]+-[a-z]+-\d\d)$/.exec(res.headers.location as string)?.[1];
    expect(roomId).toBeDefined();
    expect(registry.has(roomId!)).toBe(true);
  });

  it("also accepts a POST without a body", async () => {
    const { app } = await start(false);
    expect((await app.inject({ method: "POST", url: "/start" })).statusCode).toBe(303);
  });

  it("redirects / to /start", async () => {
    const { app } = await start(false);
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/start");
  });

  it("no longer exposes POST /api/rooms", async () => {
    const { app } = await start(true);
    expect((await app.inject({ method: "POST", url: "/api/rooms" })).statusCode).toBe(404);
  });
});

describe("joining rooms", () => {
  it("reports unknown rooms as missing when joining doesn't create them", async () => {
    const { app, registry } = await start(false);
    expect((await app.inject({ method: "GET", url: "/api/rooms/unknown123" })).statusCode).toBe(404);
    const room = registry.create();
    expect((await app.inject({ method: "GET", url: `/api/rooms/${room.id}` })).statusCode).toBe(200);
  });

  it("treats any valid ID as joinable when joining creates rooms", async () => {
    const { app } = await start(true);
    expect((await app.inject({ method: "GET", url: "/api/rooms/unknown123" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/rooms/bad%20id!" })).statusCode).toBe(404);
  });

  it("closes the socket with 4404 on hello to an unknown room", async () => {
    const { app, registry } = await start(false);
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const ws = new WebSocket(`${address.replace("http", "ws")}/ws/unknown123`);
    await new Promise((resolve) => (ws.onopen = resolve));
    ws.send(JSON.stringify({ type: "hello", clientId: "c", name: "Ann" }));
    const code = await new Promise<number>((resolve) => (ws.onclose = (event) => resolve(event.code)));
    expect(code).toBe(ROOM_NOT_FOUND_CLOSE);
    expect(registry.has("unknown123")).toBe(false);
  });

  it("creates the room on hello when allowed", async () => {
    const { app, registry } = await start(true);
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const ws = new WebSocket(`${address.replace("http", "ws")}/ws/unknown123`);
    await new Promise((resolve) => (ws.onopen = resolve));
    ws.send(JSON.stringify({ type: "hello", clientId: "c", name: "Ann" }));
    await new Promise((resolve) => (ws.onmessage = resolve));
    expect(registry.has("unknown123")).toBe(true);
    ws.close();
  });
});
