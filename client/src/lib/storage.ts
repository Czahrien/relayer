// Storage can throw (private mode, blocked site data), so every access is guarded.

function read(storage: () => Storage, key: string): string | null {
  try {
    return storage().getItem(key);
  } catch {
    return null;
  }
}

function write(storage: () => Storage, key: string, value: string): void {
  try {
    storage().setItem(key, value);
  } catch {
    // Not persisted; the in-memory value still works for this page.
  }
}

const local = () => localStorage;
const session = () => sessionStorage;

export const prefs = {
  get name(): string {
    return read(local, "lr.name") ?? "";
  },
  set name(value: string) {
    write(local, "lr.name", value);
  },
  get volume(): number {
    const v = Number(read(local, "lr.volume"));
    return read(local, "lr.volume") !== null && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
  },
  set volume(value: number) {
    write(local, "lr.volume", String(value));
  },
  /** Whether the queue shows played tracks (a per-viewer convenience). */
  get showPlayed(): boolean {
    return read(local, "lr.showPlayed") === "1";
  },
  set showPlayed(value: boolean) {
    write(local, "lr.showPlayed", value ? "1" : "0");
  },
  /** Browser notifications this viewer asked for (SPEC §8). */
  get notifySongs(): boolean {
    return read(local, "lr.notifySongs") === "1";
  },
  set notifySongs(value: boolean) {
    write(local, "lr.notifySongs", value ? "1" : "0");
  },
  get notifyChat(): boolean {
    return read(local, "lr.notifyChat") === "1";
  },
  set notifyChat(value: boolean) {
    write(local, "lr.notifyChat", value ? "1" : "0");
  },
  get muted(): boolean {
    return read(local, "lr.muted") === "1";
  },
  set muted(value: boolean) {
    write(local, "lr.muted", value ? "1" : "0");
  },
};

let memoryClientId: string | null = null;

/**
 * Identifies this listener across reconnects and reloads. Kept per tab (in
 * sessionStorage) so two tabs of the same browser are two listeners.
 */
export function getClientId(): string {
  const stored = read(session, "lr.clientId");
  if (stored) return stored;
  memoryClientId ??= crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  write(session, "lr.clientId", memoryClientId);
  return memoryClientId;
}
