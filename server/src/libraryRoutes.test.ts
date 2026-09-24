import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LibraryAlbumInfo, LibrarySearchResult, LibraryTrackInfo, RoomSnapshot, ServerMessage } from "@listening-room/shared";
import { buildApp, type App } from "./app.js";
import { taggedWav, TINY_PNG } from "./fixtures.js";
import { LIBRARY_FILE_MISSING } from "./media.js";

let base: string;
let root: string;
let ctx: App;
let roomId: string;

async function put(rel: string, content: Buffer): Promise<void> {
  const file = path.join(root, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

async function start(libraryDir: string | undefined): Promise<void> {
  ctx = await buildApp(
    {
      port: 0,
      dataDir: path.join(base, "data"),
      maxUploadBytes: 1024 * 1024,
      roomIdleTtlMs: 60_000,
      createRoomOnJoin: false,
      libraryDir,
      libraryRescanMs: 60 * 60_000,
      maxRoomBytes: Number.POSITIVE_INFINITY,
    },
    { youtube: async () => ({ youtubeId: "x", title: "x" }) },
  );
  await ctx.library?.scan();
  roomId = ctx.registry.create().id;
}

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), "lr-libroutes-"));
  root = path.join(base, "music");
  const cover = { mime: "image/png", data: TINY_PNG };
  await put("Beyoncé/B'Day/02.wav", taggedWav({ title: "Irreplaceable", artist: "Beyoncé", album: "B'Day", track: "2" }));
  await put("Beyoncé/B'Day/01.wav", taggedWav({ title: "Déjà Vu", artist: "Beyoncé", album: "B'Day", track: "1", cover }));
  await put("ACDC/Back in Black/01.wav", taggedWav({ title: "Hells Bells", artist: "AC/DC", album: "Back in Black", track: "1" }));
});

afterEach(async () => {
  await ctx.app.close();
  await fs.rm(base, { recursive: true, force: true });
});

const get = (url: string) => ctx.app.inject({ method: "GET", url });
const json = <T>(res: { json: <U>() => U }) => res.json<T>();

async function albumTracks(): Promise<LibraryTrackInfo[]> {
  const search = json<LibrarySearchResult>(await get(`/api/rooms/${roomId}/library/search?q=bday`));
  const album = json<{ album: LibraryAlbumInfo; tracks: LibraryTrackInfo[] }>(
    await get(`/api/rooms/${roomId}/library/albums/${search.albums[0]!.id}`),
  );
  return album.tracks;
}

describe("library endpoints", () => {
  beforeEach(() => start(root));

  it("answer 404 unless the room exists", async () => {
    for (const url of [
      "/api/rooms/nope-nope-nope-10/library",
      "/api/rooms/nope-nope-nope-10/library/search?q=deja",
      "/api/rooms/nope-nope-nope-10/library/albums/abc",
      "/api/rooms/nope-nope-nope-10/library/albums/abc/art",
      "/api/rooms/nope-nope-nope-10/library/artist?name=AC%2FDC",
    ]) {
      expect((await get(url)).statusCode, url).toBe(404);
    }
  });

  it("reports status", async () => {
    expect(json(await get(`/api/rooms/${roomId}/library`))).toEqual({ enabled: true, indexing: false, trackCount: 3 });
  });

  it("searches without ever exposing paths", async () => {
    const res = await get(`/api/rooms/${roomId}/library/search?q=${encodeURIComponent("déjà")}`);
    const result = json<LibrarySearchResult>(res);
    expect(result.tracks.map((t) => t.title)).toEqual(["Déjà Vu"]);
    for (const leak of [root, "Beyoncé/", ".wav", '"path"']) expect(res.body).not.toContain(leak);
    expect((await get(`/api/rooms/${roomId}/library/search?q=${"a".repeat(201)}`)).statusCode).toBe(400);
  });

  it("returns albums in order, their art, and artists by name", async () => {
    expect((await albumTracks()).map((t) => t.title)).toEqual(["Déjà Vu", "Irreplaceable"]);
    const search = json<LibrarySearchResult>(await get(`/api/rooms/${roomId}/library/search?q=bday`));
    const art = await get(`/api/rooms/${roomId}/library/albums/${search.albums[0]!.id}/art`);
    expect(art.statusCode).toBe(200);
    expect(art.headers["content-type"]).toBe("image/png");
    expect(art.rawPayload.equals(TINY_PNG)).toBe(true);

    const artist = await get(`/api/rooms/${roomId}/library/artist?name=${encodeURIComponent("AC/DC")}`);
    expect(json<{ tracks: LibraryTrackInfo[] }>(artist).tracks.map((t) => t.title)).toEqual(["Hells Bells"]);
    expect((await get(`/api/rooms/${roomId}/library/albums/unknown`)).statusCode).toBe(404);
  });
});

describe("library disabled", () => {
  beforeEach(() => start(undefined));

  it("says so, and has no search", async () => {
    expect(json(await get(`/api/rooms/${roomId}/library`))).toEqual({ enabled: false, indexing: false, trackCount: 0 });
    expect((await get(`/api/rooms/${roomId}/library/search?q=deja`)).statusCode).toBe(404);
  });
});

describe("adding library tracks to a room", () => {
  beforeEach(() => start(root));

  interface Client {
    messages: ServerMessage[];
    send(message: unknown): void;
    snapshot(where: (s: RoomSnapshot) => boolean): Promise<RoomSnapshot>;
    error(): Promise<string>;
    close(): void;
  }

  async function join(): Promise<Client> {
    const address = await ctx.app.listen({ port: 0, host: "127.0.0.1" });
    const ws = new WebSocket(`${address.replace("http", "ws")}/ws/${roomId}`);
    const messages: ServerMessage[] = [];
    let wake = () => {};
    ws.onmessage = (event) => {
      messages.push(JSON.parse(String(event.data)) as ServerMessage);
      wake();
    };
    await new Promise((resolve) => (ws.onopen = resolve));
    const waitFor = async <T>(find: () => T | undefined): Promise<T> => {
      for (;;) {
        const found = find();
        if (found !== undefined) return found;
        await new Promise<void>((resolve) => (wake = resolve));
      }
    };
    ws.send(JSON.stringify({ type: "hello", clientId: "c1", name: "Ann" }));
    return {
      messages,
      send: (m) => ws.send(JSON.stringify(m)),
      snapshot: (where) =>
        waitFor(() =>
          messages
            .filter((m): m is Extract<ServerMessage, { type: "snapshot" }> => m.type === "snapshot")
            .map((m) => m.snapshot)
            .find(where),
        ),
      error: () =>
        waitFor(() => messages.find((m): m is Extract<ServerMessage, { type: "error" }> => m.type === "error")?.message),
      close: () => ws.close(),
    };
  }

  it("adds ready items that play through the room's media URLs", async () => {
    const tracks = await albumTracks();
    const client = await join();
    client.send({ type: "addLibrary", trackIds: tracks.map((t) => t.id), position: "end" });
    const snap = await client.snapshot((s) => s.items.length === 2);

    expect(snap.items.map((i) => [i.kind, i.status, i.title])).toEqual([
      ["library", "ready", "Déjà Vu"],
      ["library", "ready", "Irreplaceable"],
    ]);
    expect(snap.items[0]).toMatchObject({ artist: "Beyoncé", album: "B'Day", trackNo: 1 });
    expect(snap.items[0]!.durationMs).toBeCloseTo(1000, -1);
    // Ready at once: playback starts, no waiting on an upload.
    expect(snap.playback).toMatchObject({ itemId: snap.items[0]!.id, state: "playing" });

    const item = snap.items[0]!;
    expect(item.mediaUrl).toBe(`/media/${roomId}/${item.id}`);
    const audio = await ctx.app.inject({ method: "GET", url: item.mediaUrl!, headers: { range: "bytes=0-3" } });
    expect(audio.statusCode).toBe(206);
    expect(audio.headers["content-type"]).toBe("audio/wav");
    expect(audio.body).toBe("RIFF");
    const art = await get(item.artUrl!);
    expect(art.rawPayload.equals(TINY_PNG)).toBe(true);
    client.close();
  });

  it("never deletes library files when items or rooms go away", async () => {
    const tracks = await albumTracks();
    const client = await join();
    client.send({ type: "addLibrary", trackIds: tracks.map((t) => t.id), position: "end" });
    const snap = await client.snapshot((s) => s.items.length === 2);
    const artFile = ctx.library!.albumArt(tracks[0]!.albumId!)!.file;

    client.send({ type: "remove", itemId: snap.items[0]!.id });
    await client.snapshot((s) => s.items.length === 1);
    ctx.media.removeRoom(roomId);
    await new Promise((resolve) => setTimeout(resolve, 50));

    await expect(fs.access(path.join(root, "Beyoncé/B'Day/01.wav"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(root, "Beyoncé/B'Day/02.wav"))).resolves.toBeUndefined();
    await expect(fs.access(artFile)).resolves.toBeUndefined();
    client.close();
  });

  it("marks an item broken when its library file disappears", async () => {
    const [first] = await albumTracks();
    const client = await join();
    client.send({ type: "addLibrary", trackIds: [first!.id], position: "end" });
    const snap = await client.snapshot((s) => s.items.length === 1);
    await fs.rm(path.join(root, "Beyoncé/B'Day/01.wav"));

    const res = await ctx.app.inject({ method: "HEAD", url: snap.items[0]!.mediaUrl! });
    expect(res.statusCode).toBe(404);
    const broken = await client.snapshot((s) => s.items[0]?.status === "error");
    expect(broken.items[0]!.error).toBe(LIBRARY_FILE_MISSING);
    client.close();
  });

  it("rejects unknown and malformed track IDs", async () => {
    const client = await join();
    await client.snapshot(() => true);
    client.send({ type: "addLibrary", trackIds: ["0123456789abcdef"], position: "end" });
    expect(await client.error()).toMatch(/no longer in the library/);
    client.messages.length = 0;
    client.send({ type: "addLibrary", trackIds: ["../etc/passwd"], position: "end" });
    expect(await client.error()).toMatch(/Invalid trackIds/);
    client.close();
  });
});
