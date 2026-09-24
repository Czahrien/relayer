import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp, type App } from "./app.js";
import { classifyFormat, parseRange } from "./media.js";

/** A mono 16-bit PCM WAV of silence. */
function wav(seconds: number, sampleRate = 8000): Buffer {
  const dataBytes = Math.round(seconds * sampleRate) * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataBytes, 40);
  return buf;
}

const actor = { clientId: "c1", name: "Alice" };

describe("media routes", () => {
  let dataDir: string;
  let ctx: App | undefined;

  /** What the stubbed disk reports as free. */
  let freeDisk = Number.POSITIVE_INFINITY;

  async function start(maxRoomBytes = Number.POSITIVE_INFINITY) {
    await ctx?.app.close();
    ctx = await buildApp(
      { port: 0, dataDir, maxUploadBytes: 64 * 1024, roomIdleTtlMs: 60_000, createRoomOnJoin: true, libraryRescanMs: 3_600_000, maxRoomBytes },
      { youtube: async () => ({ youtubeId: "x", title: "x" }), freeDiskBytes: async () => freeDisk },
    );
  }

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lr-media-"));
    freeDisk = Number.POSITIVE_INFINITY;
    await start();
  });

  afterEach(async () => {
    await ctx!.app.close();
    ctx = undefined;
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  function addPending(title = "Guess") {
    const room = ctx!.registry.getOrCreate("room1");
    const ids = room.addFiles(actor, [{ tempId: "t", title }], "end");
    return { room, itemId: ids.t! };
  }

  function upload(itemId: string, body: Buffer, roomId = "room1") {
    return ctx!.app.inject({
      method: "PUT",
      url: `/api/rooms/${roomId}/items/${itemId}/file`,
      headers: { "content-type": "audio/wav" },
      payload: body,
    });
  }

  it("stores an upload, reads its metadata, and marks it ready", async () => {
    const { room, itemId } = addPending();
    const res = await upload(itemId, wav(2));
    expect(res.statusCode).toBe(200);
    const item = room.getItem(itemId)!;
    expect(item).toMatchObject({ status: "ready", title: "Guess", mediaUrl: `/media/room1/${itemId}` });
    expect(item.durationMs).toBeCloseTo(2000, -1);
    // Stored under a server-generated name.
    const files = await fs.readdir(path.join(dataDir, "rooms", "room1"));
    expect(files).toEqual([`${itemId}.wav`]);
    // The item was current and waiting, so it starts now.
    expect(room.snapshot().playback?.state).toBe("playing");
  });

  it("serves full files and byte ranges", async () => {
    const { itemId } = addPending();
    const body = wav(1);
    await upload(itemId, body);
    const size = body.length;
    const url = `/media/room1/${itemId}`;

    const full = await ctx!.app.inject({ method: "GET", url });
    expect(full.statusCode).toBe(200);
    expect(full.headers["accept-ranges"]).toBe("bytes");
    expect(full.headers["content-type"]).toBe("audio/wav");
    expect(Number(full.headers["content-length"])).toBe(size);
    expect(full.rawPayload.equals(body)).toBe(true);

    // Safari's first probe.
    const probe = await ctx!.app.inject({ method: "GET", url, headers: { range: "bytes=0-1" } });
    expect(probe.statusCode).toBe(206);
    expect(probe.headers["content-range"]).toBe(`bytes 0-1/${size}`);
    expect(probe.headers["content-length"]).toBe("2");
    expect(probe.rawPayload.equals(body.subarray(0, 2))).toBe(true);

    const open = await ctx!.app.inject({ method: "GET", url, headers: { range: "bytes=100-" } });
    expect(open.statusCode).toBe(206);
    expect(open.headers["content-range"]).toBe(`bytes 100-${size - 1}/${size}`);
    expect(open.rawPayload.equals(body.subarray(100))).toBe(true);

    const suffix = await ctx!.app.inject({ method: "GET", url, headers: { range: "bytes=-10" } });
    expect(suffix.statusCode).toBe(206);
    expect(suffix.rawPayload.equals(body.subarray(size - 10))).toBe(true);

    const past = await ctx!.app.inject({ method: "GET", url, headers: { range: `bytes=${size}-` } });
    expect(past.statusCode).toBe(416);
    expect(past.headers["content-range"]).toBe(`bytes */${size}`);

    const head = await ctx!.app.inject({ method: "HEAD", url });
    expect(head.statusCode).toBe(200);
    expect(Number(head.headers["content-length"])).toBe(size);
  });

  it("marks non-audio uploads as errors and keeps nothing on disk", async () => {
    const { room, itemId } = addPending();
    const res = await upload(itemId, Buffer.from("this is not audio at all, just some text".repeat(20)));
    expect(res.statusCode).toBe(415);
    expect(room.getItem(itemId)).toMatchObject({ status: "error" });
    expect(await fs.readdir(path.join(dataDir, "rooms", "room1"))).toEqual([]);
  });

  it("rejects files over the upload limit", async () => {
    const { room, itemId } = addPending();
    const res = await upload(itemId, wav(10)); // 160 kB > 64 kB
    expect(res.statusCode).toBe(413);
    expect(room.getItem(itemId)?.error).toMatch(/upload limit/);
  });

  it("refuses uploads for unknown or finished items", async () => {
    const { itemId } = addPending();
    expect((await upload("nope", wav(1))).statusCode).toBe(404);
    expect((await upload(itemId, wav(1), "otherroom")).statusCode).toBe(404);
    await upload(itemId, wav(1));
    expect((await upload(itemId, wav(1))).statusCode).toBe(404);
  });

  it("caps the uploads one room can hold, and frees space when uploads are removed", async () => {
    // Each 1 s fixture is about 16 kB; the room holds 40 kB.
    await start(40 * 1024);
    const room = ctx!.registry.getOrCreate("room1");
    const ids = room.addFiles(actor, ["a", "b", "c"].map((t) => ({ tempId: t, title: t })), "end");
    expect((await upload(ids.a!, wav(1))).statusCode).toBe(200);
    expect((await upload(ids.b!, wav(1))).statusCode).toBe(200);
    const full = await upload(ids.c!, wav(1));
    expect(full.statusCode).toBe(413);
    expect(room.getItem(ids.c!)?.error).toMatch(/reached its 0 MB limit|limit for uploads/);
    expect(ctx!.media.used("room1")).toBe(2 * wav(1).length);

    // Removing an upload gives its space back.
    room.remove(actor, ids.a!);
    const [d] = Object.values(room.addFiles(actor, [{ tempId: "d", title: "d" }], "end"));
    expect((await upload(d!, wav(1))).statusCode).toBe(200);
  });

  it("keeps the room total right when uploads fail", async () => {
    await start(1024 * 1024);
    const room = ctx!.registry.getOrCreate("room1");
    const ids = room.addFiles(actor, [{ tempId: "junk", title: "junk" }, { tempId: "big", title: "big" }], "end");
    // Not audio: stored, rejected, and given back.
    await upload(ids.junk!, Buffer.from("not audio ".repeat(500)));
    // Over the 64 kB per-file limit, without a content length to catch it early.
    await ctx!.app.inject({
      method: "PUT",
      url: `/api/rooms/room1/items/${ids.big!}/file`,
      headers: { "content-type": "audio/wav", "transfer-encoding": "chunked" },
      payload: wav(10),
    });
    expect(room.getItem(ids.big!)?.status).toBe("error");
    expect(ctx!.media.used("room1")).toBe(0);
  });

  it("refuses uploads when the disk is nearly full", async () => {
    freeDisk = 100 * 1024 * 1024; // below the 512 MB reserve
    const { room, itemId } = addPending();
    const res = await upload(itemId, wav(1));
    expect(res.statusCode).toBe(507);
    expect(room.getItem(itemId)?.error).toMatch(/out of disk space/);
  });

  it("deletes files when their item is removed", async () => {
    const { room, itemId } = addPending();
    await upload(itemId, wav(1));
    room.remove(actor, itemId);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await fs.readdir(path.join(dataDir, "rooms", "room1"))).toEqual([]);
    expect((await ctx!.app.inject({ method: "GET", url: `/media/room1/${itemId}` })).statusCode).toBe(404);
  });
});

describe("parseRange", () => {
  it.each([
    ["bytes=0-1", 100, { start: 0, end: 1 }],
    ["bytes=0-", 100, { start: 0, end: 99 }],
    ["bytes=50-500", 100, { start: 50, end: 99 }],
    ["bytes=-10", 100, { start: 90, end: 99 }],
    ["bytes=-500", 100, { start: 0, end: 99 }],
    ["bytes=100-", 100, "unsatisfiable"],
    ["bytes=-0", 100, "unsatisfiable"],
    ["bytes=5-2", 100, null],
    ["bytes=0-1,5-6", 100, null],
    ["items=0-1", 100, null],
    ["bytes=-", 100, null],
  ] as const)("%s of %i", (header, size, expected) => {
    expect(parseRange(header, size)).toEqual(expected);
  });
});

describe("classifyFormat", () => {
  it.each([
    [{ container: "MPEG", codec: "MPEG 1 Layer 3" }, "audio/mpeg"],
    [{ container: "FLAC", codec: "FLAC" }, "audio/flac"],
    [{ container: "Ogg", codec: "Opus" }, "audio/ogg"],
    [{ container: "Ogg", codec: "Vorbis I" }, "audio/ogg"],
    [{ container: "WAVE", codec: "PCM" }, "audio/wav"],
    [{ container: "WAVE", codec: "IEEE_FLOAT" }, "audio/wav"],
    [{ container: "WAVE", codec: "non-PCM (65534)" }, "audio/wav"],
    [{ container: "M4A/isom/iso2", codec: "MPEG-4/AAC" }, "audio/mp4"],
    [{ container: "mp42/isom", codec: "AAC" }, "audio/mp4"],
    [{ container: "EBML/webm", codec: "OPUS" }, "audio/webm"],
    [{ container: "ADTS/MPEG-4", codec: "AAC" }, "audio/aac"],
  ])("accepts %o", (format, mime) => {
    expect(classifyFormat(format)).toMatchObject({ ok: true, mime });
  });

  it.each([
    [{ container: "M4A/isom/iso2", codec: "ALAC" }, /ALAC/],
    [{ container: "ASF/audio", codec: "Windows Media Audio 9.1" }, /WMA/],
    [{ container: "Monkey's Audio", codec: undefined }, /Monkey's Audio/],
    [{ container: "WAVE", codec: "ADPCM" }, /ADPCM/],
  ])("rejects %o with a clear message", (format, message) => {
    const verdict = classifyFormat(format);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.message).toMatch(message);
  });
});
