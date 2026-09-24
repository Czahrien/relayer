// Server clock offset estimation from ping/pong samples (§6.1).

export interface ClockSample {
  at: number; // client time the pong arrived
  rtt: number;
  offset: number; // serverTime - clientTime
}

const BURST_ON_CONNECT = 8;
const BURST_PERIODIC = 3;
const BURST_SPACING_MS = 100;
const PERIOD_MS = 30_000;
const WINDOW_MS = 2 * 60_000;

/** Monotonic client time in epoch ms; `Date.now()` can jump with the system clock. */
export function clientNow(): number {
  return performance.timeOrigin + performance.now();
}

export function makeSample(t0: number, t1: number, serverTime: number): ClockSample {
  const rtt = t1 - t0;
  return { at: t1, rtt, offset: serverTime + rtt / 2 - t1 };
}

/** The lowest-RTT sample no older than `windowMs`; its offset has the least asymmetry error. */
export function bestSample(samples: readonly ClockSample[], now: number, windowMs = WINDOW_MS): ClockSample | null {
  let best: ClockSample | null = null;
  for (const sample of samples) {
    if (now - sample.at > windowMs) continue;
    if (!best || sample.rtt < best.rtt) best = sample;
  }
  return best;
}

export class ClockSync {
  offset = 0;
  bestRtt: number | null = null;
  private samples: ClockSample[] = [];
  private timers: ReturnType<typeof setTimeout>[] = [];
  private periodic: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly sendPing: (t0: number) => void,
    private readonly now: () => number = clientNow,
  ) {}

  get synced(): boolean {
    return this.samples.length > 0;
  }

  serverNow(): number {
    return this.now() + this.offset;
  }

  /** Starts over, e.g. after a reconnect (the client may have slept). */
  start(): void {
    this.stop();
    this.samples = [];
    this.burst(BURST_ON_CONNECT);
    this.periodic = setInterval(() => this.burst(BURST_PERIODIC), PERIOD_MS);
  }

  stop(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
    if (this.periodic) clearInterval(this.periodic);
    this.periodic = null;
  }

  handlePong(t0: number, serverTime: number): void {
    const now = this.now();
    if (t0 > now) return;
    this.samples.push(makeSample(t0, now, serverTime));
    this.samples = this.samples.filter((s) => now - s.at <= WINDOW_MS);
    const best = bestSample(this.samples, now);
    if (best) {
      this.offset = best.offset;
      this.bestRtt = best.rtt;
    }
  }

  private burst(count: number): void {
    for (let i = 0; i < count; i++) {
      this.timers.push(setTimeout(() => this.sendPing(this.now()), i * BURST_SPACING_MS));
    }
    // Drop finished timer handles.
    this.timers = this.timers.slice(-count);
  }
}
