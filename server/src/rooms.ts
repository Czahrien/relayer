import { ROOM_ID_PATTERN } from "@listening-room/shared";
import { Room, systemClock, type Clock, type RoomHooks } from "./room.js";
import { generateRoomName } from "./roomNames.js";

const SWEEP_INTERVAL_MS = 60_000;

export interface RegistryOptions {
  idleTtlMs: number;
  hooksFor(roomId: string): RoomHooks;
  /** Called after a room is dropped, to delete its files. */
  onDelete?(roomId: string): void;
  clock?: Clock;
}

/** Owns every live room and deletes rooms that stay empty too long. */
export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();
  private readonly clock: Clock;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: RegistryOptions) {
    this.clock = options.clock ?? systemClock;
  }

  static isValidId(roomId: string): boolean {
    return ROOM_ID_PATTERN.test(roomId);
  }

  create(): Room {
    let roomId = generateRoomName();
    while (this.rooms.has(roomId)) roomId = generateRoomName();
    return this.getOrCreate(roomId);
  }

  get(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  /** Unknown IDs create the room, so shared links survive a server restart (§5). */
  getOrCreate(roomId: string): Room {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = new Room(roomId, this.options.hooksFor(roomId), this.clock);
      this.rooms.set(roomId, room);
    }
    return room;
  }

  has(roomId: string): boolean {
    return this.rooms.has(roomId);
  }

  /** Deletes rooms that have had no listeners for the idle TTL. */
  sweep(): void {
    const now = this.clock.now();
    for (const [roomId, room] of this.rooms) {
      if (room.emptySince !== null && now - room.emptySince >= this.options.idleTtlMs) {
        room.dispose();
        this.rooms.delete(roomId);
        this.options.onDelete?.(roomId);
      }
    }
  }

  start(): void {
    this.sweepTimer ??= setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    for (const room of this.rooms.values()) room.dispose();
  }
}
