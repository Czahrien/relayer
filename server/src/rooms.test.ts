import { describe, expect, it } from "vitest";
import { RoomRegistry } from "./rooms.js";
import { FakeClock } from "./testing.js";

const TTL = 60 * 60_000;

function setup() {
  const clock = new FakeClock();
  const deleted: string[] = [];
  const registry = new RoomRegistry({ idleTtlMs: TTL, hooksFor: () => ({}), onDelete: (id) => deleted.push(id), clock });
  return { clock, deleted, registry };
}

describe("RoomRegistry", () => {
  it("creates rooms with nanoid(10) IDs", () => {
    const { registry } = setup();
    const room = registry.create();
    expect(room.id).toMatch(/^[A-Za-z0-9_-]{10}$/);
    expect(registry.get(room.id)).toBe(room);
  });

  it("creates unknown rooms on demand so old links keep working", () => {
    const { registry } = setup();
    expect(registry.has("oldLink123")).toBe(false);
    const room = registry.getOrCreate("oldLink123");
    expect(registry.getOrCreate("oldLink123")).toBe(room);
  });

  it("validates room IDs", () => {
    expect(RoomRegistry.isValidId("abc_DEF-123")).toBe(true);
    expect(RoomRegistry.isValidId("../etc")).toBe(false);
    expect(RoomRegistry.isValidId("")).toBe(false);
    expect(RoomRegistry.isValidId("a".repeat(65))).toBe(false);
  });

  it("deletes rooms that stay empty for the idle TTL", () => {
    const { clock, deleted, registry } = setup();
    const room = registry.create();
    clock.advance(TTL - 1);
    registry.sweep();
    expect(deleted).toEqual([]);
    clock.advance(1);
    registry.sweep();
    expect(deleted).toEqual([room.id]);
    expect(registry.has(room.id)).toBe(false);
  });

  it("keeps rooms with listeners, and restarts the clock when the last one leaves", () => {
    const { clock, deleted, registry } = setup();
    const room = registry.create();
    room.join("a", "Ann");
    clock.advance(TTL * 3);
    registry.sweep();
    expect(deleted).toEqual([]);
    room.leave("a");
    clock.advance(TTL - 1000);
    registry.sweep();
    expect(deleted).toEqual([]);
    clock.advance(1000);
    registry.sweep();
    expect(deleted).toEqual([room.id]);
  });
});
