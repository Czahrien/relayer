import {
  MAX_LIBRARY_BATCH,
  MAX_NAME_LENGTH,
  type AddPosition,
  type ClientMessage,
  type FileDescriptor,
  type ListenerSyncState,
} from "@relayer/shared";
import { CommandError } from "./room.js";

const MAX_FILES_PER_BATCH = 2000;
const MAX_TEXT = 300;
const SYNC_STATES: ListenerSyncState[] = ["playing", "paused", "buffering", "loading", "idle"];

type Obj = Record<string, unknown>;

function str(o: Obj, key: string, max = MAX_TEXT): string {
  const value = o[key];
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new CommandError(`Invalid ${key}.`);
  }
  return value;
}

function optStr(o: Obj, key: string): string | undefined {
  const value = o[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new CommandError(`Invalid ${key}.`);
  return cleanText(value, MAX_TEXT);
}

function num(o: Obj, key: string): number {
  const value = o[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new CommandError(`Invalid ${key}.`);
  return value;
}

function optPositiveInt(o: Obj, key: string): number | undefined {
  const value = o[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 10_000) {
    throw new CommandError(`Invalid ${key}.`);
  }
  return value;
}

function position(o: Obj): AddPosition {
  const value = o.position ?? "end";
  if (value !== "end" && value !== "next") throw new CommandError("Invalid position.");
  return value;
}

/** Collapses whitespace and strips control characters. */
export function cleanText(value: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

export function cleanName(value: unknown): string {
  const name = typeof value === "string" ? cleanText(value, MAX_NAME_LENGTH) : "";
  return name || "Listener";
}

function fileDescriptor(value: unknown): FileDescriptor {
  if (typeof value !== "object" || value === null) throw new CommandError("Invalid file.");
  const o = value as Obj;
  return {
    tempId: str(o, "tempId", 64),
    title: cleanText(str(o, "title", 1000), MAX_TEXT) || "Untitled",
    artist: optStr(o, "artist"),
    album: optStr(o, "album"),
    discNo: optPositiveInt(o, "discNo"),
    trackNo: optPositiveInt(o, "trackNo"),
  };
}

/** Parses raw socket data into a well-formed message, or throws CommandError. */
export function parseClientMessage(raw: string): ClientMessage {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new CommandError("Messages must be JSON.");
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new CommandError("Messages must be objects.");
  }
  const o = data as Obj;
  switch (o.type) {
    case "hello":
      return { type: "hello", clientId: str(o, "clientId", 64), name: cleanName(o.name) };
    case "ping":
      return { type: "ping", t0: num(o, "t0") };
    case "addYoutube":
      return { type: "addYoutube", url: str(o, "url", 2000), position: position(o) };
    case "addFiles": {
      const files = o.files;
      if (!Array.isArray(files) || files.length === 0 || files.length > MAX_FILES_PER_BATCH) {
        throw new CommandError("Invalid files.");
      }
      return { type: "addFiles", files: files.map(fileDescriptor), position: position(o) };
    }
    case "addLibrary": {
      const ids = o.trackIds;
      if (
        !Array.isArray(ids) ||
        ids.length === 0 ||
        ids.length > MAX_LIBRARY_BATCH ||
        !ids.every((id) => typeof id === "string" && /^[a-f0-9]{1,64}$/.test(id))
      ) {
        throw new CommandError("Invalid trackIds.");
      }
      return { type: "addLibrary", trackIds: ids as string[], position: position(o) };
    }
    case "play":
    case "pause":
    case "next":
    case "previous":
    case "restart":
    case "clear":
      return { type: o.type };
    case "seek":
      return { type: "seek", positionMs: num(o, "positionMs") };
    case "jump":
    case "playNext":
    case "remove":
    case "ended":
      return { type: o.type, itemId: str(o, "itemId", 64) };
    case "move":
      return { type: "move", itemId: str(o, "itemId", 64), toIndex: num(o, "toIndex") };
    case "reportDuration":
      return { type: "reportDuration", itemId: str(o, "itemId", 64), durationMs: num(o, "durationMs") };
    case "itemError":
      return {
        type: "itemError",
        itemId: str(o, "itemId", 64),
        message: cleanText(str(o, "message", 1000), 200),
      };
    case "status": {
      const state = o.state as ListenerSyncState;
      if (!SYNC_STATES.includes(state)) throw new CommandError("Invalid state.");
      const driftMs = o.driftMs === null ? null : num(o, "driftMs");
      return { type: "status", driftMs, state };
    }
    default:
      throw new CommandError("Unknown message type.");
  }
}
