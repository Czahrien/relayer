import { describe, expect, it } from "vitest";
import { positionAt, type ActivityEntry } from "@relayer/shared";
import { CommandError, Room, UPLOAD_ABANDON_MS, type Actor } from "./room.js";
import { FakeClock } from "./testing.js";

const alice: Actor = { clientId: "a", name: "Alice" };
const bob: Actor = { clientId: "b", name: "Bob" };
const MIN = 60_000;

function setup() {
  const clock = new FakeClock();
  const removed: string[] = [];
  const activity: ActivityEntry[] = [];
  let changes = 0;
  const room = new Room(
    "room1",
    {
      onChange: () => changes++,
      onItemsRemoved: (items) => removed.push(...items.map((item) => item.title)),
      onActivity: (entry) => activity.push(entry),
    },
    clock,
  );
  const state = () => room.snapshot();
  const titles = () => state().items.map((item) => item.title);
  const current = () => {
    const s = state();
    return s.playback ? s.items[s.currentIndex]?.title : undefined;
  };
  const id = (title: string) => {
    const item = state().items.find((i) => i.title === title);
    if (!item) throw new Error(`no item ${title}`);
    return item.id;
  };
  /** Adds file items and completes their uploads, like a finished drop. */
  const addReady = (names: string[], position: "end" | "next" = "end", durationMs = 3 * MIN) => {
    const ids = room.addFiles(
      alice,
      names.map((title) => ({ tempId: `t-${title}`, title })),
      position,
    );
    for (const name of names) room.completeUpload(ids[`t-${name}`]!, { durationMs });
    return names.map((name) => ids[`t-${name}`]!);
  };
  const position = () => positionAt(state().playback!, clock.now());
  return { room, clock, removed, activity, state, titles, current, id, addReady, position, changes: () => changes };
}

describe("adding items", () => {
  it("auto-starts the first new item when the room is idle", () => {
    const { room, state, current, addReady, clock } = setup();
    addReady(["A", "B"]);
    expect(current()).toBe("A");
    const pb = state().playback!;
    expect(pb.state).toBe("playing");
    expect(pb.anchorPosMs).toBe(0);
    expect(pb.anchorTime).toBe(clock.now() + 1000);
    // Adding more while playing does not interrupt.
    room.addFiles(alice, [{ tempId: "c", title: "C" }], "end");
    expect(current()).toBe("A");
  });

  it("auto-starts at the first new item after the queue finished", () => {
    const { room, current, addReady, state } = setup();
    addReady(["A"]);
    room.next(alice);
    expect(state().playback).toBeNull();
    expect(state().currentIndex).toBe(1);
    addReady(["B", "C"]);
    expect(current()).toBe("B");
    expect(state().currentIndex).toBe(1);
  });

  it("inserts `next` items right after the current one", () => {
    const { titles, current, addReady } = setup();
    addReady(["A", "B"]);
    addReady(["X", "Y"], "next");
    expect(titles()).toEqual(["A", "X", "Y", "B"]);
    expect(current()).toBe("A");
  });

  it("waits on an item that is still uploading, then starts it with the new-track lead", () => {
    const { room, state, clock } = setup();
    const ids = room.addFiles(alice, [{ tempId: "t", title: "Slow" }], "end");
    expect(state().playback).toMatchObject({ itemId: ids.t, state: "waiting" });
    clock.advance(5000);
    room.completeUpload(ids.t!, { title: "Slow (tagged)", durationMs: MIN });
    const pb = state().playback!;
    expect(pb).toMatchObject({ state: "playing", anchorPosMs: 0, anchorTime: clock.now() + 1000 });
    expect(state().items[0]).toMatchObject({ status: "ready", title: "Slow (tagged)", durationMs: MIN });
  });

  it("keeps client-guessed tags when the server finds none", () => {
    const { room, state } = setup();
    const ids = room.addFiles(alice, [{ tempId: "t", title: "Guess", artist: "Band", trackNo: 3 }], "end");
    room.completeUpload(ids.t!, { title: undefined, artist: "Real Band", durationMs: MIN });
    expect(state().items[0]).toMatchObject({ title: "Guess", artist: "Real Band", trackNo: 3 });
  });

  it("summarizes additions in the activity feed", () => {
    const { room, activity } = setup();
    room.addFiles(
      alice,
      [
        { tempId: "1", title: "One", album: "Record" },
        { tempId: "2", title: "Two", album: "Record" },
      ],
      "end",
    );
    expect(activity.at(-1)).toMatchObject({ by: "Alice", text: "added 2 tracks from “Record”" });
  });

  it("bumps rev on every change", () => {
    const { room, state, addReady } = setup();
    const before = state().rev;
    addReady(["A"]);
    const after = state().rev;
    expect(after).toBeGreaterThan(before);
    room.pause(alice);
    expect(state().rev).toBe(after + 1);
  });
});

describe("transport", () => {
  it("pauses at the current position and resumes with a lead", () => {
    const { room, state, clock, addReady } = setup();
    addReady(["A"]);
    clock.advance(1000 + 10_000);
    room.pause(alice);
    expect(state().playback).toMatchObject({ state: "paused", anchorPosMs: 10_000 });
    clock.advance(60_000);
    room.play(alice);
    expect(state().playback).toMatchObject({ state: "playing", anchorPosMs: 10_000, anchorTime: clock.now() + 300 });
  });

  it("pausing during the start lead keeps the anchor position", () => {
    const { room, state, clock, addReady } = setup();
    addReady(["A"]);
    clock.advance(400);
    room.pause(alice);
    expect(state().playback).toMatchObject({ state: "paused", anchorPosMs: 0 });
  });

  it("seeks while playing with a lead, and while paused without one", () => {
    const { room, state, clock, addReady } = setup();
    addReady(["A"]);
    room.seek(alice, 30_000);
    expect(state().playback).toMatchObject({ state: "playing", anchorPosMs: 30_000, anchorTime: clock.now() + 300 });
    room.pause(alice);
    room.seek(alice, 5000);
    expect(state().playback).toMatchObject({ state: "paused", anchorPosMs: 5000, anchorTime: clock.now() });
  });

  it("clamps seeks to the item's duration", () => {
    const { room, state, addReady } = setup();
    addReady(["A"], "end", MIN);
    room.seek(alice, 10 * MIN);
    expect(state().playback!.anchorPosMs).toBe(MIN);
    room.seek(alice, -5);
    expect(state().playback!.anchorPosMs).toBe(0);
  });

  it("restart seeks to 0 and keeps a paused room paused", () => {
    const { room, state, clock, addReady } = setup();
    addReady(["A"]);
    clock.advance(20_000);
    room.pause(alice);
    room.restart(alice);
    expect(state().playback).toMatchObject({ state: "paused", anchorPosMs: 0 });
  });

  it("next advances, and past the last item goes idle", () => {
    const { room, state, current, addReady } = setup();
    addReady(["A", "B"]);
    room.next(alice);
    expect(current()).toBe("B");
    room.next(alice);
    expect(state().playback).toBeNull();
    expect(state().currentIndex).toBe(2);
    // History stays.
    expect(state().items).toHaveLength(2);
  });

  it("previous restarts when past 3 s", () => {
    const { room, state, clock, current, addReady } = setup();
    addReady(["A", "B"]);
    room.next(alice);
    clock.advance(1000 + 3500);
    room.previous(alice);
    expect(current()).toBe("B");
    expect(state().playback).toMatchObject({ anchorPosMs: 0, anchorTime: clock.now() + 300 });
  });

  it("previous goes to the previous item when within 3 s", () => {
    const { room, clock, current, addReady } = setup();
    addReady(["A", "B"]);
    room.next(alice);
    clock.advance(1000 + 2000);
    room.previous(alice);
    expect(current()).toBe("A");
  });

  it("previous restarts the first item when there is nothing before it", () => {
    const { room, state, clock, current, addReady } = setup();
    addReady(["A"]);
    clock.advance(1500);
    room.previous(alice);
    expect(current()).toBe("A");
    expect(state().playback).toMatchObject({ anchorPosMs: 0 });
  });

  it("previous from idle goes to the last item", () => {
    const { room, current, addReady } = setup();
    addReady(["A", "B"]);
    room.next(alice);
    room.next(alice);
    room.previous(alice);
    expect(current()).toBe("B");
  });

  it("previous skips error items", () => {
    const { room, current, id, addReady } = setup();
    addReady(["A", "Bad", "C"]);
    room.itemError(id("Bad"), "nope");
    room.jump(alice, id("C"));
    room.previous(alice);
    expect(current()).toBe("A");
  });
});

describe("jump", () => {
  it("jumps backward, making later items upcoming again", () => {
    const { room, state, current, id, addReady } = setup();
    addReady(["A", "B", "C"]);
    room.next(alice);
    room.next(alice);
    room.jump(alice, id("A"));
    expect(current()).toBe("A");
    expect(state().currentIndex).toBe(0);
    expect(state().playback).toMatchObject({ state: "playing", anchorPosMs: 0 });
    room.next(alice);
    expect(current()).toBe("B");
  });

  it("rejects unknown and error items", () => {
    const { room, id, addReady } = setup();
    addReady(["A", "B"]);
    room.itemError(id("B"), "nope");
    expect(() => room.jump(alice, "missing")).toThrow(CommandError);
    expect(() => room.jump(alice, id("B"))).toThrow(CommandError);
  });
});

describe("remove", () => {
  it("removing an item before the current one decrements currentIndex", () => {
    const { room, state, current, id, addReady, removed } = setup();
    addReady(["A", "B", "C"]);
    room.next(alice);
    const pb = state().playback;
    room.remove(alice, id("A"));
    expect(state().currentIndex).toBe(0);
    expect(current()).toBe("B");
    expect(state().playback).toEqual(pb);
    expect(removed).toEqual(["A"]);
  });

  it("removing the current item starts the next one", () => {
    const { room, current, id, addReady } = setup();
    addReady(["A", "B"]);
    room.remove(alice, id("A"));
    expect(current()).toBe("B");
  });

  it("removing the current last item goes idle", () => {
    const { room, state, id, addReady } = setup();
    addReady(["A", "B"]);
    room.next(alice);
    room.remove(alice, id("B"));
    expect(state().playback).toBeNull();
    expect(state().currentIndex).toBe(1);
  });

  it("removing an upcoming item leaves playback alone", () => {
    const { room, state, current, id, addReady } = setup();
    addReady(["A", "B", "C"]);
    const pb = state().playback;
    room.remove(alice, id("C"));
    expect(current()).toBe("A");
    expect(state().playback).toEqual(pb);
  });

  it("removing history while idle keeps the room idle", () => {
    const { room, state, id, addReady } = setup();
    addReady(["A", "B"]);
    room.next(alice);
    room.next(alice);
    room.remove(alice, id("A"));
    expect(state().currentIndex).toBe(1);
    expect(state().playback).toBeNull();
  });
});

describe("move", () => {
  it("reorders upcoming items", () => {
    const { room, titles, current, id, addReady } = setup();
    addReady(["A", "B", "C", "D"]);
    room.move(alice, id("D"), 1);
    expect(titles()).toEqual(["A", "D", "B", "C"]);
    expect(current()).toBe("A");
  });

  it("moving the current item keeps it current", () => {
    const { room, state, current, id, addReady } = setup();
    addReady(["A", "B", "C"]);
    const pb = state().playback;
    room.move(alice, id("A"), 2);
    expect(current()).toBe("A");
    expect(state().currentIndex).toBe(2);
    expect(state().playback).toEqual(pb);
  });

  it("moving a history item after the current one decrements currentIndex", () => {
    const { room, state, titles, current, id, addReady } = setup();
    addReady(["A", "B", "C"]);
    room.next(alice);
    room.move(alice, id("A"), 2);
    expect(titles()).toEqual(["B", "C", "A"]);
    expect(state().currentIndex).toBe(0);
    expect(current()).toBe("B");
  });

  it("moving an upcoming item into history increments currentIndex", () => {
    const { room, state, current, id, addReady } = setup();
    addReady(["A", "B", "C"]);
    room.next(alice);
    room.move(alice, id("C"), 0);
    expect(state().currentIndex).toBe(2);
    expect(current()).toBe("B");
  });

  it("rejects out-of-range indexes", () => {
    const { room, id, addReady } = setup();
    addReady(["A", "B"]);
    expect(() => room.move(alice, id("A"), 2)).toThrow(CommandError);
    expect(() => room.move(alice, id("A"), -1)).toThrow(CommandError);
    expect(() => room.move(alice, id("A"), 0.5)).toThrow(CommandError);
  });
});

describe("playNext", () => {
  it("moves a history item to just after the current one", () => {
    const { room, state, titles, current, id, addReady } = setup();
    addReady(["A", "B", "C", "D"]);
    room.next(alice);
    room.next(alice); // current C, history A B
    room.playNext(alice, id("A"));
    expect(titles()).toEqual(["B", "C", "A", "D"]);
    expect(state().currentIndex).toBe(1);
    expect(current()).toBe("C");
    room.next(alice);
    expect(current()).toBe("A");
  });

  it("moves an upcoming item forward", () => {
    const { room, titles, current, id, addReady } = setup();
    addReady(["A", "B", "C", "D"]);
    room.playNext(alice, id("D"));
    expect(titles()).toEqual(["A", "D", "B", "C"]);
    expect(current()).toBe("A");
  });

  it("does nothing for the current item", () => {
    const { room, titles, id, addReady } = setup();
    addReady(["A", "B"]);
    room.playNext(alice, id("A"));
    expect(titles()).toEqual(["A", "B"]);
  });

  it("from idle, moves the item to the end and plays it", () => {
    const { room, state, titles, current, id, addReady } = setup();
    addReady(["A", "B"]);
    room.next(alice);
    room.next(alice);
    room.playNext(alice, id("A"));
    expect(titles()).toEqual(["B", "A"]);
    expect(current()).toBe("A");
    expect(state().currentIndex).toBe(1);
  });
});

describe("clear", () => {
  it("removes everything and goes idle", () => {
    const { room, state, addReady, removed } = setup();
    addReady(["A", "B"]);
    room.next(alice);
    room.clear(alice);
    expect(state()).toMatchObject({ items: [], currentIndex: 0, playback: null });
    expect(removed).toEqual(["A", "B"]);
  });

  it("forgets pending uploads", () => {
    const { room, state } = setup();
    const ids = room.addFiles(alice, [{ tempId: "t", title: "Up" }], "end");
    room.clear(alice);
    expect(room.pendingUpload(ids.t!)).toBeUndefined();
    expect(room.completeUpload(ids.t!, {})).toBe(false);
    expect(state().items).toEqual([]);
  });
});

describe("clearPlayed", () => {
  it("removes the played tracks and keeps the current one playing", () => {
    const { room, state, titles, current, addReady, removed } = setup();
    addReady(["A", "B", "C", "D"]);
    room.next(alice);
    room.next(alice); // current C
    const pb = state().playback;
    room.clearPlayed(alice);
    expect(titles()).toEqual(["C", "D"]);
    expect(state().currentIndex).toBe(0);
    expect(current()).toBe("C");
    expect(state().playback).toEqual(pb);
    expect(removed).toEqual(["A", "B"]);
  });

  it("clears everything once the queue has finished", () => {
    const { room, state, addReady } = setup();
    addReady(["A", "B"]);
    room.next(alice);
    room.next(alice);
    room.clearPlayed(alice);
    expect(state()).toMatchObject({ items: [], currentIndex: 0, playback: null });
  });

  it("does nothing when nothing has played", () => {
    const { room, state, addReady, activity } = setup();
    addReady(["A", "B"]);
    const rev = state().rev;
    room.clearPlayed(alice);
    expect(state().rev).toBe(rev);
    expect(activity.at(-1)?.text).not.toMatch(/cleared/);
  });

  it("says so in the activity feed", () => {
    const { room, addReady, activity } = setup();
    addReady(["A", "B", "C"]);
    room.next(alice);
    room.next(alice);
    room.clearPlayed(alice);
    expect(activity.at(-1)).toMatchObject({ by: "Alice", text: "cleared 2 played tracks", kind: "event" });
  });
});

describe("chat", () => {
  it("adds messages to the activity log without changing room state", () => {
    const { room, state, activity } = setup();
    const rev = state().rev;
    room.say(alice, "this one's a banger");
    expect(activity.at(-1)).toMatchObject({ by: "Alice", text: "this one's a banger", kind: "message" });
    expect(room.activity().at(-1)?.kind).toBe("message");
    expect(state().rev).toBe(rev);
  });

  it("keeps the most recent 200 entries", () => {
    const { room } = setup();
    for (let i = 0; i < 250; i++) room.say(alice, `message ${i}`);
    const log = room.activity();
    expect(log).toHaveLength(200);
    expect(log[0]!.text).toBe("message 50");
  });
});

describe("advancing", () => {
  it("advances on the server timer when the duration runs out", () => {
    const { clock, current, state, addReady } = setup();
    addReady(["A", "B"], "end", MIN);
    clock.advance(1000 + MIN + 249);
    expect(current()).toBe("A");
    clock.advance(1);
    expect(current()).toBe("B");
    clock.advance(1000 + MIN + 250);
    expect(state().playback).toBeNull();
  });

  it("does not advance while paused, and reschedules on resume", () => {
    const { room, clock, current, addReady } = setup();
    addReady(["A", "B"], "end", MIN);
    clock.advance(1000 + 30_000);
    room.pause(alice);
    clock.advance(10 * MIN);
    expect(current()).toBe("A");
    room.play(alice);
    clock.advance(300 + 30_000 + 250);
    expect(current()).toBe("B");
  });

  it("reschedules after a seek", () => {
    const { room, clock, current, addReady } = setup();
    addReady(["A", "B"], "end", MIN);
    clock.advance(1000);
    room.seek(alice, 50_000);
    clock.advance(300 + 10_000 + 250);
    expect(current()).toBe("B");
  });

  it("relies on `ended` when the duration is unknown", () => {
    const { room, clock, current, id, addReady } = setup();
    room.addYoutube(alice, { youtubeId: "dQw4w9WgXcQ", title: "Video" }, "end");
    addReady(["B"]);
    clock.advance(60 * MIN);
    expect(current()).toBe("Video");
    room.ended(id("Video"));
    expect(current()).toBe("B");
  });

  it("dedupes `ended` from several clients", () => {
    const { room, current, id, addReady } = setup();
    room.addYoutube(alice, { youtubeId: "dQw4w9WgXcQ", title: "Video" }, "end");
    addReady(["B", "C"]);
    room.ended(id("Video"));
    room.ended(id("Video"));
    expect(current()).toBe("B");
  });

  it("ignores `ended` well before a known duration", () => {
    const { room, clock, current, id, addReady } = setup();
    addReady(["A", "B"], "end", MIN);
    clock.advance(1000 + 30_000);
    room.ended(id("A"));
    expect(current()).toBe("A");
    clock.advance(28_500); // 58.5 s in: within the 2 s tolerance
    room.ended(id("A"));
    expect(current()).toBe("B");
  });

  it("ignores `ended` while paused", () => {
    const { room, clock, current, id, addReady } = setup();
    room.addYoutube(alice, { youtubeId: "dQw4w9WgXcQ", title: "Video" }, "end");
    addReady(["B"]);
    clock.advance(2000);
    room.pause(alice);
    room.ended(id("Video"));
    expect(current()).toBe("Video");
  });

  it("uses a reported duration for the timer, and accepts only the first report", () => {
    const { room, clock, state, current, id, addReady } = setup();
    room.addYoutube(alice, { youtubeId: "dQw4w9WgXcQ", title: "Video" }, "end");
    addReady(["B"]);
    room.reportDuration(id("Video"), MIN);
    room.reportDuration(id("Video"), 5 * MIN);
    expect(state().items[0]!.durationMs).toBe(MIN);
    clock.advance(1000 + MIN + 250);
    expect(current()).toBe("B");
  });
});

describe("errors", () => {
  it("skips error items when the pointer reaches them", () => {
    const { room, current, id, addReady } = setup();
    addReady(["A", "Bad", "C"]);
    room.itemError(id("Bad"), "Can't decode");
    room.next(alice);
    expect(current()).toBe("C");
  });

  it("skips the current item when it errors", () => {
    const { room, state, current, id, addReady } = setup();
    addReady(["A", "B"]);
    room.itemError(id("A"), "Can't decode");
    expect(current()).toBe("B");
    expect(state().items[0]).toMatchObject({ status: "error", error: "Can't decode" });
  });

  it("goes idle when only error items remain", () => {
    const { room, state } = setup();
    room.addYoutube(alice, { youtubeId: "dQw4w9WgXcQ", title: "Blocked", error: "Embedding disabled" }, "end");
    expect(state().playback).toBeNull();
    expect(state().currentIndex).toBe(1);
  });

  it("a failed upload of the waiting item skips it", () => {
    const { room, current, addReady } = setup();
    const ids = room.addFiles(alice, [{ tempId: "t", title: "Broken" }], "end");
    addReady(["B"]);
    room.failUpload(ids.t!, "Not audio");
    expect(current()).toBe("B");
  });
});

describe("listeners", () => {
  it("counts connections per client so reconnects are the same listener", () => {
    const { room, state } = setup();
    room.join("a", "Alice");
    room.join("a", "Alice");
    room.join("b", "Bob");
    expect(state().listeners).toHaveLength(2);
    room.leave("a");
    expect(state().listeners).toHaveLength(2);
    room.leave("a");
    expect(state().listeners.map((l) => l.name)).toEqual(["Bob"]);
    expect(room.emptySince).toBeNull();
    room.leave("b");
    expect(room.emptySince).not.toBeNull();
  });

  it("fails an abandoned upload when its uploader doesn't come back", () => {
    const { room, clock, state } = setup();
    room.join(bob.clientId, bob.name);
    const ids = room.addFiles(bob, [{ tempId: "t", title: "Up" }], "end");
    room.leave(bob.clientId);
    clock.advance(UPLOAD_ABANDON_MS);
    expect(state().items[0]).toMatchObject({ id: ids.t, status: "error" });
  });

  it("keeps uploads alive when the uploader reconnects", () => {
    const { room, clock, state } = setup();
    room.join(bob.clientId, bob.name);
    room.addFiles(bob, [{ tempId: "t", title: "Up" }], "end");
    room.leave(bob.clientId);
    clock.advance(1000);
    room.join(bob.clientId, bob.name);
    clock.advance(UPLOAD_ABANDON_MS);
    expect(state().items[0]!.status).toBe("uploading");
  });
});
