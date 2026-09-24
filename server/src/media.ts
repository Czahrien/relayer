import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { joinedArtist } from "@listening-room/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import { parseFile, selectCover, type IFormat } from "music-metadata";
import type { LibrarySource } from "./library/source.js";
import type { RoomRegistry } from "./rooms.js";
import type { UploadedMetadata } from "./room.js";

/** Where a room item's bytes come from. */
export interface MediaRecord {
  mime: string;
  /** An uploaded file in the room's folder: owned by the room and deleted with it. */
  file?: { path: string; size: number };
  /** A library track, read through its source: referenced, never deleted (SPEC §10.1). */
  library?: { source: LibrarySource; path: string };
  /** Cover art. Only `owned` art (extracted from an upload) is deleted with the item. */
  art?: { path: string; mime: string; owned: boolean };
}

/** Shown when a referenced library file can't be opened. */
export const LIBRARY_FILE_MISSING = "This file is no longer in the library.";

/**
 * Tracks the files stored for each room under DATA_DIR/rooms/<roomId>/.
 * Filenames are always server-generated item IDs, never user-supplied names.
 */
export class MediaStore {
  readonly root: string;
  private readonly records = new Map<string, MediaRecord>();
  /** Bytes of uploads each room holds, including uploads still streaming in. */
  private readonly usage = new Map<string, number>();
  private readonly uploads = new Map<string, AbortController>();

  constructor(dataDir: string) {
    this.root = path.join(dataDir, "rooms");
  }

  /** No room survives a restart, so every existing room directory is stale. */
  async init(): Promise<void> {
    await fs.rm(this.root, { recursive: true, force: true });
    await fs.mkdir(this.root, { recursive: true });
  }

  /** Upload bytes the room holds (library tracks don't count: they're referenced). */
  used(roomId: string): number {
    return this.usage.get(roomId) ?? 0;
  }

  /** Adds (or, with a negative number, returns) upload bytes to a room's total. */
  charge(roomId: string, bytes: number): void {
    const total = Math.max(0, this.used(roomId) + bytes);
    if (total === 0) this.usage.delete(roomId);
    else this.usage.set(roomId, total);
  }

  roomDir(roomId: string): string {
    return path.join(this.root, roomId);
  }

  get(roomId: string, itemId: string): MediaRecord | undefined {
    return this.records.get(key(roomId, itemId));
  }

  set(roomId: string, itemId: string, record: MediaRecord): void {
    this.records.set(key(roomId, itemId), record);
  }

  /** Registers an upload in progress; returns null if one is already running. */
  beginUpload(roomId: string, itemId: string): AbortController | null {
    const k = key(roomId, itemId);
    if (this.uploads.has(k)) return null;
    const controller = new AbortController();
    this.uploads.set(k, controller);
    return controller;
  }

  endUpload(roomId: string, itemId: string): void {
    this.uploads.delete(key(roomId, itemId));
  }

  removeItems(roomId: string, itemIds: string[]): void {
    for (const itemId of itemIds) {
      const k = key(roomId, itemId);
      this.uploads.get(k)?.abort();
      this.uploads.delete(k);
      const record = this.records.get(k);
      this.records.delete(k);
      if (record?.file) {
        this.charge(roomId, -record.file.size);
        void fs.rm(record.file.path, { force: true });
      }
      if (record?.art?.owned) void fs.rm(record.art.path, { force: true });
    }
  }

  removeRoom(roomId: string): void {
    const prefix = `${roomId}/`;
    for (const [k, controller] of this.uploads) {
      if (k.startsWith(prefix)) {
        controller.abort();
        this.uploads.delete(k);
      }
    }
    for (const k of this.records.keys()) if (k.startsWith(prefix)) this.records.delete(k);
    this.usage.delete(roomId);
    // Only the room's own folder: referenced library files and art live elsewhere.
    void fs.rm(this.roomDir(roomId), { recursive: true, force: true });
  }
}

function key(roomId: string, itemId: string): string {
  return `${roomId}/${itemId}`;
}

// ---- Codec support ----

export type FormatVerdict = { ok: true; ext: string; mime: string } | { ok: false; message: string };

/** Decides whether browsers can play a parsed file natively (§7, "Codec support"). */
export function classifyFormat(format: Pick<IFormat, "container" | "codec">): FormatVerdict {
  const container = (format.container ?? "").toLowerCase();
  const codec = (format.codec ?? "").toLowerCase();

  if (container === "mpeg") return { ok: true, ext: "mp3", mime: "audio/mpeg" };
  if (container === "flac") return { ok: true, ext: "flac", mime: "audio/flac" };
  if (container.startsWith("adts")) return { ok: true, ext: "aac", mime: "audio/aac" };
  if (container === "ogg") {
    if (codec.includes("speex")) return { ok: false, message: "Speex audio isn't supported by browsers." };
    return { ok: true, ext: "ogg", mime: "audio/ogg" };
  }
  if (container.startsWith("wave")) {
    // WAVE_FORMAT_EXTENSIBLE (65534) is how 24-bit PCM is usually stored.
    if (codec === "" || codec === "pcm" || codec === "ieee_float" || codec.endsWith("(65534)")) {
      return { ok: true, ext: "wav", mime: "audio/wav" };
    }
    return { ok: false, message: `This WAV file uses ${format.codec}, which browsers can't play.` };
  }
  if (container.startsWith("ebml")) return { ok: true, ext: "webm", mime: "audio/webm" };
  if (container.startsWith("asf")) {
    return { ok: false, message: "WMA files aren't supported by browsers. Convert it to MP3, AAC, or FLAC." };
  }
  if (/\b(m4a|m4b|m4p|mp4|mp41|mp42|isom|iso\d|dash|3gp\d?|f4a)\b/.test(container)) {
    if (codec.includes("alac")) {
      return {
        ok: false,
        message: "Apple Lossless (ALAC) isn't supported by most browsers. Convert it to AAC or FLAC.",
      };
    }
    return { ok: true, ext: "m4a", mime: "audio/mp4" };
  }
  const name = format.container ?? "This format";
  return { ok: false, message: `${name} files aren't supported by browsers.` };
}

// ---- Range requests ----

export type ByteRange = { start: number; end: number };

/**
 * Parses a single-range `Range` header. Returns null when the header should be
 * ignored (malformed or multi-range), or "unsatisfiable" for a 416.
 */
export function parseRange(header: string, size: number): ByteRange | "unsatisfiable" | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart = "", rawEnd = ""] = match;
  if (rawStart === "" && rawEnd === "") return null;

  if (rawStart === "") {
    const suffix = Number(rawEnd);
    if (suffix === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(rawStart);
  const end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (rawEnd !== "" && Number(rawEnd) < start) return null;
  if (start >= size) return "unsatisfiable";
  return { start, end };
}

// ---- Routes ----

class TooLargeError extends Error {}
class RoomFullError extends Error {}

/** Leave this much disk free for everything else on the server. */
export const MIN_FREE_DISK_BYTES = 512 * 1024 * 1024;

/**
 * Passes bytes through while enforcing the per-file limit and charging the
 * room as they arrive, so concurrent uploads can't overshoot the room limit.
 */
function meteredUpload(
  media: MediaStore,
  roomId: string,
  maxFileBytes: number,
  maxRoomBytes: number,
): Transform & { received: number } {
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (stream.received + chunk.length > maxFileBytes) return callback(new TooLargeError());
      if (media.used(roomId) + chunk.length > maxRoomBytes) return callback(new RoomFullError());
      stream.received += chunk.length;
      media.charge(roomId, chunk.length);
      callback(null, chunk);
    },
  }) as Transform & { received: number };
  stream.received = 0;
  return stream;
}

export interface MediaRouteOptions {
  maxUploadBytes: number;
  /** Total upload storage per room (Infinity for no limit). */
  maxRoomBytes: number;
  /** Free space where uploads are stored; overridable for tests. */
  freeDiskBytes?: () => Promise<number>;
}

export function registerMediaRoutes(
  app: FastifyInstance,
  registry: RoomRegistry,
  media: MediaStore,
  { maxUploadBytes, maxRoomBytes, freeDiskBytes }: MediaRouteOptions,
): void {
  const mb = (bytes: number) => Math.round(bytes / 1024 / 1024);
  const tooLarge = `This file is larger than the ${mb(maxUploadBytes)} MB upload limit.`;
  const roomFull = `This room has reached its ${mb(maxRoomBytes)} MB limit for uploads. Remove some uploads to add more.`;
  const diskFull = "The server is almost out of disk space, so it can't take more uploads right now.";
  const freeDisk =
    freeDiskBytes ??
    (async () => {
      const stats = await fs.statfs(media.root);
      return stats.bavail * stats.bsize;
    });

  // Uploads are raw bodies streamed straight to disk, so this scope skips body parsing.
  void app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", (_request, _payload, done) => done(null));

    scope.put<{ Params: { roomId: string; itemId: string } }>(
      "/api/rooms/:roomId/items/:itemId/file",
      async (request, reply) => {
        const { roomId, itemId } = request.params;
        const room = registry.get(roomId);
        if (!room?.pendingUpload(itemId)) {
          return reply.code(404).send({ error: "That item isn't waiting for an upload." });
        }
        const declared = Number(request.headers["content-length"]);
        const size = Number.isFinite(declared) ? declared : 0;
        if (size > maxUploadBytes) {
          room.failUpload(itemId, tooLarge);
          return reply.code(413).header("connection", "close").send({ error: tooLarge });
        }
        if (media.used(roomId) + size > maxRoomBytes) {
          room.failUpload(itemId, roomFull);
          return reply.code(413).header("connection", "close").send({ error: roomFull });
        }
        if ((await freeDisk()) - size < MIN_FREE_DISK_BYTES) {
          room.failUpload(itemId, diskFull);
          request.log.warn({ roomId }, "upload refused: low disk space");
          return reply.code(507).header("connection", "close").send({ error: diskFull });
        }
        const controller = media.beginUpload(roomId, itemId);
        if (!controller) return reply.code(409).send({ error: "This item is already being uploaded." });

        const dir = media.roomDir(roomId);
        const partPath = path.join(dir, `${itemId}.part`);
        const meter = meteredUpload(media, roomId, maxUploadBytes, maxRoomBytes);
        /** Deletes the partial file and gives its bytes back to the room. */
        const discard = async () => {
          await fs.rm(partPath, { force: true });
          media.charge(roomId, -meter.received);
        };
        try {
          await fs.mkdir(dir, { recursive: true });
          await pipeline(request.raw, meter, createWriteStream(partPath), {
            signal: controller.signal,
          });
        } catch (err) {
          await discard();
          if (controller.signal.aborted) return reply.code(410).send({ error: "The item was removed." });
          if (err instanceof TooLargeError || err instanceof RoomFullError) {
            const message = err instanceof TooLargeError ? tooLarge : roomFull;
            room.failUpload(itemId, message);
            return reply.code(413).header("connection", "close").send({ error: message });
          }
          room.failUpload(itemId, "The upload didn't finish.");
          request.log.warn({ err, itemId }, "upload interrupted");
          return reply.code(400).send({ error: "The upload didn't finish." });
        } finally {
          media.endUpload(roomId, itemId);
        }

        const result = await ingestFile(partPath, dir, itemId);
        if (!result.ok) {
          await discard();
          room.failUpload(itemId, result.message);
          return reply.code(415).send({ error: result.message });
        }
        if (!room.pendingUpload(itemId)) {
          // Removed while we were parsing.
          media.charge(roomId, -meter.received);
          if (result.record.file) await fs.rm(result.record.file.path, { force: true });
          if (result.record.art) await fs.rm(result.record.art.path, { force: true });
          return reply.code(410).send({ error: "The item was removed." });
        }
        media.set(roomId, itemId, result.record);
        const artUrl = result.record.art ? `/media/${roomId}/${itemId}/art` : undefined;
        room.completeUpload(itemId, { ...result.meta, artUrl });
        return reply.code(200).send({ ok: true });
      },
    );
  });

  app.get<{ Params: { roomId: string; itemId: string } }>("/media/:roomId/:itemId", async (request, reply) => {
    const { roomId, itemId } = request.params;
    const record = media.get(roomId, itemId);
    if (!record) return reply.code(404).send({ error: "Not found." });
    if (record.file) {
      const file = record.file.path;
      return sendRange(reply, request.headers.range, record.file.size, record.mime, async (range) =>
        createReadStream(file, range),
      );
    }
    const library = record.library!;
    const stat = await library.source.stat(library.path);
    if (!stat) {
      // Deleted or moved since it was added: it's broken for everyone, not a client problem.
      registry.get(roomId)?.itemError(itemId, LIBRARY_FILE_MISSING);
      return reply.code(404).send({ error: LIBRARY_FILE_MISSING });
    }
    return sendRange(reply, request.headers.range, stat.size, record.mime, (range) =>
      library.source.open(library.path, range),
    );
  });

  app.get<{ Params: { roomId: string; itemId: string } }>("/media/:roomId/:itemId/art", async (request, reply) => {
    const art = media.get(request.params.roomId, request.params.itemId)?.art;
    if (!art) return reply.code(404).send({ error: "Not found." });
    return sendImage(reply, art.path, art.mime);
  });
}

/** Serves an image file, or 404 if it's gone. */
export async function sendImage(reply: FastifyReply, file: string, mime: string) {
  const stat = await fs.stat(file).catch(() => null);
  if (!stat) return reply.code(404).send({ error: "Not found." });
  return reply
    .header("content-type", mime)
    .header("content-length", stat.size)
    .header("cache-control", "private, max-age=86400")
    .send(createReadStream(file));
}

/** Serves bytes with the Range support Safari insists on (§5). */
async function sendRange(
  reply: FastifyReply,
  rangeHeader: string | undefined,
  size: number,
  mime: string,
  open: (range?: { start: number; end: number }) => Promise<Readable>,
) {
  reply
    .header("accept-ranges", "bytes")
    .header("content-type", mime)
    .header("cache-control", "private, max-age=86400, immutable");

  const range = rangeHeader ? parseRange(rangeHeader, size) : null;
  if (range === "unsatisfiable") {
    return reply.code(416).header("content-range", `bytes */${size}`).send();
  }
  if (range) {
    return reply
      .code(206)
      .header("content-range", `bytes ${range.start}-${range.end}/${size}`)
      .header("content-length", range.end - range.start + 1)
      .send(await open(range));
  }
  return reply.code(200).header("content-length", size).send(size === 0 ? "" : await open());
}

/** Normalizes a tag's picture format; old ID3 tags use bare names like "JPG". */
export function imageMime(format: string): string | null {
  const f = format.toLowerCase();
  if (f.startsWith("image/")) return f === "image/jpg" ? "image/jpeg" : f;
  if (f === "jpg" || f === "jpeg") return "image/jpeg";
  if (f === "png" || f === "gif" || f === "webp") return `image/${f}`;
  return null;
}

type IngestResult =
  | { ok: true; record: MediaRecord; meta: UploadedMetadata }
  | { ok: false; message: string };

/** Parses an uploaded file, checks its codec, and moves it and its cover into place. */
async function ingestFile(partPath: string, dir: string, itemId: string): Promise<IngestResult> {
  let parsed;
  try {
    parsed = await parseFile(partPath, { duration: true });
  } catch {
    return { ok: false, message: "This file couldn't be read as audio." };
  }
  const verdict = classifyFormat(parsed.format);
  if (!verdict.ok) return verdict;

  const filePath = path.join(dir, `${itemId}.${verdict.ext}`);
  await fs.rename(partPath, filePath);
  const { size } = await fs.stat(filePath);
  const record: MediaRecord = { mime: verdict.mime, file: { path: filePath, size } };

  const cover = selectCover(parsed.common.picture);
  const artMime = cover && imageMime(cover.format);
  if (cover && artMime) {
    record.art = { path: path.join(dir, `${itemId}.art`), mime: artMime, owned: true };
    await fs.writeFile(record.art.path, cover.data);
  }

  const { common, format } = parsed;
  const meta: UploadedMetadata = {
    title: common.title?.trim() || undefined,
    artist: (joinedArtist(common) ?? common.albumartist)?.trim() || undefined,
    album: common.album?.trim() || undefined,
    discNo: common.disk.no ?? undefined,
    trackNo: common.track.no ?? undefined,
    durationMs: format.duration && Number.isFinite(format.duration) ? Math.round(format.duration * 1000) : undefined,
  };
  return { ok: true, record, meta };
}
