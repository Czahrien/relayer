import type { Clock } from "./room.js";

interface Timer {
  id: number;
  at: number;
  fn: () => void;
}

/** A manually advanced clock for deterministic room tests. */
export class FakeClock implements Clock {
  private timers: Timer[] = [];
  private nextId = 1;

  constructor(public t = 1_000_000) {}

  now(): number {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const timer = { id: this.nextId++, at: this.t + Math.max(0, ms), fn };
    this.timers.push(timer);
    return timer.id;
  }

  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((timer) => timer.id !== handle);
  }

  /** Advances time, firing due timers in order. */
  advance(ms: number): void {
    const target = this.t + ms;
    for (;;) {
      const due = this.timers.filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((timer) => timer !== due);
      this.t = due.at;
      due.fn();
    }
    this.t = target;
  }

  get pending(): number {
    return this.timers.length;
  }
}
