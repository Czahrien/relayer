import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RoomSnapshot, ServerMessage, YouTubeResult } from "@relayer/shared";
import { buildApp, type App } from "./app.js";
import { fakeYouTube, type FakeVideo } from "./fixtures.js";
import { YouTubeData } from "./youtubeApi.js";

const VIDEOS: Record<string, FakeVideo> = {
  mamboSun000: { title: "Mambo Sun", channel: "T.Rex - Topic", duration: "PT3M40S" },
  cosmic00000: { title: "Cosmic Dancer", channel: "T.Rex - Topic", duration: "PT4M30S" },
  blocked0000: { title: "Official Video", channel: "LabelVEVO", duration: "PT4M", embeddable: false },
};
const ALBUM = "OLAK5uy_ktIG_lU06uGTq4dwpDuurDU-DcykrLuE4";

let ctx: App;
let dataDir: string;

async function start(withApi: boolean) {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lr-yt-"));
  const yt = fakeYouTube({
    videos: VIDEOS,
    search: ["mamboSun000", "blocked0000", "cosmic00000"],
    playlists: { [ALBUM]: { title: "Album - Electric Warrior", items: ["mamboSun000", "blocked0000", "gone0000000", "cosmic00000"] } },
  });
  ctx = await buildApp(
    {
      port: 0,
      dataDir,
      maxUploadBytes: 1024 * 1024,
      roomIdleTtlMs: 60_000,
      createRoomOnJoin: false,
      libraryRescanMs: 3_600_000,
      maxRoomBytes: Number.POSITIVE_INFINITY,
    },
    {
      youtube: async () => ({ youtubeId: "mamboSun000", title: "From oEmbed" }),
      youtubeData: withApi ? new YouTubeData("key", yt.fetchImpl) : null,
    },
  );
  return { roomId: ctx.registry.create().id, calls: yt.calls };
}

afterEach(async () => {
  await ctx.app.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

const get = (url: string) => ctx.app.inject({ method: "GET", url });

async function join(roomId: string) {
  const address = await ctx.app.listen({ port: 0, host: "127.0.0.1" });
  const ws = new WebSocket(`${address.replace("http", "ws")}/ws/${roomId}`);
  const messages: ServerMessage[] = [];
  let wake = () => {};
  ws.onmessage = (event) => {
    messages.push(JSON.parse(String(event.data)) as ServerMessage);
    wake();
  };
  await new Promise((resolve) => (ws.onopen = resolve));
  ws.send(JSON.stringify({ type: "hello", clientId: "c", name: "Ann" }));
  const waitFor = async <T>(find: () => T | undefined): Promise<T> => {
    for (;;) {
      const found = find();
      if (found !== undefined) return found;
      await new Promise<void>((resolve) => (wake = resolve));
    }
  };
  return {
    messages,
    waitFor,
    add: (url: string) => ws.send(JSON.stringify({ type: "addYoutube", url, position: "end" })),
    snapshot: (where: (s: RoomSnapshot) => boolean) =>
      waitFor(() => messages.flatMap((m) => (m.type === "snapshot" ? [m.snapshot] : [])).find(where)),
    message: <T extends ServerMessage["type"]>(type: T) =>
      waitFor(() => messages.find((m): m is Extract<ServerMessage, { type: T }> => m.type === type)),
    close: () => ws.close(),
  };
}

describe("YouTube search endpoints", () => {
  it("report whether search is enabled", async () => {
    const { roomId } = await start(true);
    expect((await get(`/api/rooms/${roomId}/youtube`)).json()).toEqual({ enabled: true });
    expect((await get("/api/rooms/no-such-room-10/youtube")).statusCode).toBe(404);
  });

  it("search, keeping only videos that can play", async () => {
    const { roomId } = await start(true);
    const res = await get(`/api/rooms/${roomId}/youtube/search?q=${encodeURIComponent("t rex")}`);
    const { results } = res.json<{ results: YouTubeResult[] }>();
    expect(results.map((r) => [r.title, r.channel, r.durationMs])).toEqual([
      ["Mambo Sun", "T.Rex", 220_000],
      ["Cosmic Dancer", "T.Rex", 270_000],
    ]);
    expect((await get(`/api/rooms/${roomId}/youtube/search?q=${"x".repeat(201)}`)).statusCode).toBe(400);
  });

  it("limit how fast one room can search", async () => {
    const { roomId } = await start(true);
    for (let i = 0; i < 10; i++) expect((await get(`/api/rooms/${roomId}/youtube/search?q=q${i}`)).statusCode).toBe(200);
    const limited = await get(`/api/rooms/${roomId}/youtube/search?q=one-more`);
    expect(limited.statusCode).toBe(429);
    // Another room has its own allowance.
    const other = ctx.registry.create().id;
    expect((await get(`/api/rooms/${other}/youtube/search?q=hello`)).statusCode).toBe(200);
  });

  it("are off without an API key", async () => {
    const { roomId } = await start(false);
    expect((await get(`/api/rooms/${roomId}/youtube`)).json()).toEqual({ enabled: false });
    expect((await get(`/api/rooms/${roomId}/youtube/search?q=x`)).statusCode).toBe(404);
  });
});

describe("adding YouTube links", () => {
  it("expands a playlist link into its playable tracks, in order, as an album", async () => {
    const { roomId } = await start(true);
    const client = await join(roomId);
    client.add(`https://music.youtube.com/playlist?list=${ALBUM}&si=abc`);
    const snap = await client.snapshot((s) => s.items.length > 0);
    expect(snap.items.map((i) => [i.kind, i.status, i.title, i.artist, i.album, i.durationMs])).toEqual([
      ["youtube", "ready", "Mambo Sun", "T.Rex", "Electric Warrior", 220_000],
      ["youtube", "ready", "Cosmic Dancer", "T.Rex", "Electric Warrior", 270_000],
    ]);
    expect((await client.message("notice")).message).toBe("Left out 2 videos from that playlist that can't play here.");
    const added = await client.waitFor(() =>
      client.messages.flatMap((m) => (m.type === "activity" ? m.entries : [])).find((e) => e.text.startsWith("added")),
    );
    expect(added.text).toBe("added 2 tracks from “Electric Warrior”");
    client.close();
  });

  it("gets single videos' durations from the API, and marks blocked ones", async () => {
    const { roomId } = await start(true);
    const client = await join(roomId);
    client.add("https://youtu.be/mamboSun000");
    client.add("https://youtu.be/blocked0000");
    const snap = await client.snapshot((s) => s.items.length === 2);
    expect(snap.items[0]).toMatchObject({ title: "Mambo Sun", durationMs: 220_000, status: "ready" });
    expect(snap.items[1]).toMatchObject({ title: "Official Video", status: "error" });
    client.close();
  });

  it("explains that playlists need the API, and still adds single videos through oEmbed", async () => {
    const { roomId } = await start(false);
    const client = await join(roomId);
    client.add(`https://music.youtube.com/playlist?list=${ALBUM}`);
    expect((await client.message("error")).message).toMatch(/can't open YouTube playlists/);
    client.add("https://youtu.be/mamboSun000");
    const snap = await client.snapshot((s) => s.items.length === 1);
    expect(snap.items[0]!.title).toBe("From oEmbed");
    client.close();
  });
});
