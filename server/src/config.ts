import path from "node:path";

export interface Config {
  port: number;
  dataDir: string;
  maxUploadBytes: number;
  roomIdleTtlMs: number;
}

function positiveNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number, got "${raw}"`);
  return value;
}

export function loadConfig(): Config {
  return {
    port: positiveNumber("PORT", 3000),
    dataDir: path.resolve(process.env.DATA_DIR || "./data"),
    maxUploadBytes: positiveNumber("MAX_UPLOAD_MB", 300) * 1024 * 1024,
    roomIdleTtlMs: positiveNumber("ROOM_IDLE_TTL_MIN", 60) * 60 * 1000,
  };
}
