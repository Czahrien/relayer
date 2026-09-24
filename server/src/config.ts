import path from "node:path";

export interface Config {
  port: number;
  dataDir: string;
  maxUploadBytes: number;
  /** Total upload storage per room; Infinity when MAX_ROOM_MB is 0. */
  maxRoomBytes: number;
  roomIdleTtlMs: number;
  /** Whether opening a link to an unknown room creates it (§5). Turn off when room creation is behind auth. */
  createRoomOnJoin: boolean;
  /** Root of the server music library (SPEC §10); undefined disables it. */
  libraryDir?: string;
  libraryRescanMs: number;
}

function positiveNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number, got "${raw}"`);
  return value;
}

/** A number of megabytes where 0 means "no limit". */
function megabytesOrUnlimited(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw !== undefined && raw.trim() === "0") return Number.POSITIVE_INFINITY;
  return positiveNumber(name, fallback) * 1024 * 1024;
}

function boolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`${name} must be true or false, got "${process.env[name]}"`);
}

export function loadConfig(): Config {
  return {
    port: positiveNumber("PORT", 3000),
    dataDir: path.resolve(process.env.DATA_DIR || "./data"),
    maxUploadBytes: positiveNumber("MAX_UPLOAD_MB", 300) * 1024 * 1024,
    maxRoomBytes: megabytesOrUnlimited("MAX_ROOM_MB", 2048),
    roomIdleTtlMs: positiveNumber("ROOM_IDLE_TTL_MIN", 60) * 60 * 1000,
    createRoomOnJoin: boolean("CREATE_ROOM_ON_JOIN", true),
    libraryDir: process.env.LIBRARY_DIR ? path.resolve(process.env.LIBRARY_DIR) : undefined,
    libraryRescanMs: positiveNumber("LIBRARY_RESCAN_MIN", 360) * 60 * 1000,
  };
}
