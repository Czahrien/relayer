import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance, FastifyReply } from "fastify";
import { parseFile, selectCover, type IFormat } from "music-metadata";
import type { RoomRegistry } from "./rooms.js";
import type { UploadedMetadata } from "./room.js";

interface MediaRecord {
  path: string;
  mime: string;
  size: number;
  artPath?: string;
  artMime?: string;
}

/**
 * Tracks the files stored for each room under DATA_DIR/rooms/<roomId>/.
 * Filenames are always server-generated item IDs, never user-supplied names.
 */
export class MediaStore {
  readonly root: string;
  private readonly records = new Map<string, MediaRecord>();
  private readonly uploads = new Map<string, AbortController>();

  constructor(dataDir: string) {
    this.root = path.join(dataDir, "rooms");
  }

  /** No room survives a restart, so every existing room directory is stale. */
  async init(): Promise<void> {
    await fs.rm(this.root, { recursive: true, force: true });
    await fs.mkdir(this.root, { recursive: true });
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
      if (record) {
        void fs.rm(record.path, { force: true });
        if (record.artPath) void fs.rm(record.artPath, { force: true });
      }
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

function byteLimit(max: number): Transform {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      if (total > max) callback(new TooLargeError());
      else callback(null, chunk);
    },
  });
}

export interface MediaRouteOptions {
  maxUploadBytes: number;
}

export function registerMediaRoutes(
  app: FastifyInstance,
  registry: RoomRegistry,
  media: MediaStore,
  { maxUploadBytes }: MediaRouteOptions,
): void {
  const maxMb = Math.round(maxUploadBytes / 1024 / 1024);
  const tooLarge = `This file is larger than the ${maxMb} MB upload limit.`;

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
        if (Number.isFinite(declared) && declared > maxUploadBytes) {
          room.failUpload(itemId, tooLarge);
          return reply.code(413).header("connection", "close").send({ error: tooLarge });
        }
        const controller = media.beginUpload(roomId, itemId);
        if (!controller) return reply.code(409).send({ error: "This item is already being uploaded." });

        const dir = media.roomDir(roomId);
        const partPath = path.join(dir, `${itemId}.part`);
        const discard = () => fs.rm(partPath, { force: true });
        try {
          await fs.mkdir(dir, { recursive: true });
          await pipeline(request.raw, byteLimit(maxUploadBytes), createWriteStream(partPath), {
            signal: controller.signal,
          });
        } catch (err) {
          await discard();
          if (controller.signal.aborted) return reply.code(410).send({ error: "The item was removed." });
          if (err instanceof TooLargeError) {
            room.failUpload(itemId, tooLarge);
            return reply.code(413).header("connection", "close").send({ error: tooLarge });
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
          await fs.rm(result.record.path, { force: true });
          if (result.record.artPath) await fs.rm(result.record.artPath, { force: true });
          return reply.code(410).send({ error: "The item was removed." });
        }
        media.set(roomId, itemId, result.record);
        const artUrl = result.record.artPath ? `/media/${roomId}/${itemId}/art` : undefined;
        room.completeUpload(itemId, { ...result.meta, artUrl });
        return reply.code(200).send({ ok: true });
      },
    );
  });

  app.get<{ Params: { roomId: string; itemId: string } }>("/media/:roomId/:itemId", async (request, reply) => {
    const record = media.get(request.params.roomId, request.params.itemId);
    if (!record) return reply.code(404).send({ error: "Not found." });
    return sendRange(reply, request.headers.range, record.path, record.size, record.mime);
  });

  app.get<{ Params: { roomId: string; itemId: string } }>("/media/:roomId/:itemId/art", async (request, reply) => {
    const record = media.get(request.params.roomId, request.params.itemId);
    if (!record?.artPath || !record.artMime) return reply.code(404).send({ error: "Not found." });
    const stat = await fs.stat(record.artPath).catch(() => null);
    if (!stat) return reply.code(404).send({ error: "Not found." });
    return reply
      .header("content-type", record.artMime)
      .header("content-length", stat.size)
      .header("cache-control", "private, max-age=86400, immutable")
      .send(createReadStream(record.artPath));
  });
}

/** Serves a file with the Range support Safari insists on (§5). */
function sendRange(reply: FastifyReply, rangeHeader: string | undefined, file: string, size: number, mime: string) {
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
      .send(createReadStream(file, { start: range.start, end: range.end }));
  }
  return reply.code(200).header("content-length", size).send(size === 0 ? "" : createReadStream(file));
}

/** Normalizes a tag's picture format; old ID3 tags use bare names like "JPG". */
function imageMime(format: string): string | null {
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
  const record: MediaRecord = { path: filePath, mime: verdict.mime, size };

  const cover = selectCover(parsed.common.picture);
  const artMime = cover && imageMime(cover.format);
  if (cover && artMime) {
    record.artPath = path.join(dir, `${itemId}.art`);
    record.artMime = artMime;
    await fs.writeFile(record.artPath, cover.data);
  }

  const { common, format } = parsed;
  const meta: UploadedMetadata = {
    title: common.title?.trim() || undefined,
    artist: (common.artist ?? common.albumartist)?.trim() || undefined,
    album: common.album?.trim() || undefined,
    discNo: common.disk.no ?? undefined,
    trackNo: common.track.no ?? undefined,
    durationMs: format.duration && Number.isFinite(format.duration) ? Math.round(format.duration * 1000) : undefined,
  };
  return { ok: true, record, meta };
}
