import type { QueueItem } from "@listening-room/shared";
import type { Player } from "./Player.js";

/** 0.1 s of silent 8 kHz mono WAV, used to unlock audio elements in the Join gesture. */
function silentWavUri(): string {
  const samples = 800;
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) =>
    [...text].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 16000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples * 2, true);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return `data:audio/wav;base64,${btoa(binary)}`;
}

const MEDIA_ERRORS: Record<number, string> = {
  1: "Playback was aborted.",
  2: "A network error stopped the download.",
  3: "This browser couldn't decode the file.",
  4: "This browser can't play this file's format.",
};

/**
 * Plays files through two reused <audio> elements: one active, one preloading
 * the next file, swapping roles at each track change (§6.7).
 */
export class FilePlayer implements Player {
  readonly kind = "file" as const;
  private readonly els: [HTMLAudioElement, HTMLAudioElement];
  private readonly itemIds: [string | null, string | null] = [null, null];
  private active: 0 | 1 = 0;
  private endedCb = () => {};
  private errorCb = (_message: string) => {};
  private durationCb = (_ms: number) => {};

  constructor() {
    this.els = [this.createElement(0), this.createElement(1)];
  }

  /**
   * Must run synchronously inside the Join click: iOS only lets an element play
   * programmatically after it has played once in a user gesture.
   */
  unlock(): void {
    const src = silentWavUri();
    for (const el of this.els) {
      el.src = src;
      const attempt = el.play();
      el.pause();
      attempt?.catch(() => {});
    }
  }

  private get el(): HTMLAudioElement {
    return this.els[this.active];
  }

  get loadedItemId(): string | null {
    return this.itemIds[this.active];
  }

  async load(item: QueueItem): Promise<void> {
    if (!item.mediaUrl) throw new Error("This item has no media URL.");
    this.el.pause();
    const other = this.active === 0 ? 1 : 0;
    if (this.itemIds[other] === item.id) {
      this.active = other;
    } else if (this.itemIds[this.active] !== item.id) {
      this.setSource(this.active, item.id, item.mediaUrl);
    }
    const el = this.el;
    el.playbackRate = 1;
    await waitForMetadata(el);
    if (Number.isFinite(el.duration) && el.duration > 0) this.durationCb(el.duration * 1000);
  }

  /** Warms up the inactive element with the next upcoming file. */
  preload(item: QueueItem | null): void {
    const other = this.active === 0 ? 1 : 0;
    if (!item?.mediaUrl || this.itemIds[other] === item.id || this.itemIds[this.active] === item.id) return;
    this.setSource(other, item.id, item.mediaUrl);
  }

  play(): Promise<void> {
    return this.el.play();
  }

  pause(): void {
    for (const el of this.els) if (!el.paused) el.pause();
  }

  seek(ms: number): void {
    const el = this.el;
    const target = Math.max(0, ms / 1000);
    el.currentTime = Number.isFinite(el.duration) ? Math.min(target, el.duration) : target;
  }

  positionMs(): number {
    return this.el.currentTime * 1000;
  }

  setRate(rate: number): void {
    const el = this.el;
    if (el.playbackRate !== rate) el.playbackRate = rate;
  }

  setVolume(v: number): void {
    for (const el of this.els) {
      el.volume = v;
      // iOS ignores `volume`, so muting has to go through `muted`.
      el.muted = v === 0;
    }
  }

  isBuffering(): boolean {
    const el = this.el;
    return el.seeking || el.readyState < HTMLMediaElement.HAVE_FUTURE_DATA;
  }

  isPaused(): boolean {
    return this.el.paused;
  }

  isEnded(): boolean {
    return this.el.ended;
  }

  onEnded(cb: () => void): void {
    this.endedCb = cb;
  }

  onError(cb: (message: string) => void): void {
    this.errorCb = cb;
  }

  onDuration(cb: (ms: number) => void): void {
    this.durationCb = cb;
  }

  destroy(): void {
    for (const el of this.els) {
      el.pause();
      el.removeAttribute("src");
      el.load();
    }
    this.itemIds[0] = this.itemIds[1] = null;
  }

  private setSource(index: 0 | 1, itemId: string, url: string): void {
    const el = this.els[index];
    this.itemIds[index] = itemId;
    el.src = url;
    el.load();
  }

  private createElement(index: 0 | 1): HTMLAudioElement {
    const el = new Audio();
    el.preload = "auto";
    el.preservesPitch = true;
    const isActive = () => this.active === index && this.itemIds[index] !== null;
    el.addEventListener("ended", () => isActive() && this.endedCb());
    el.addEventListener("error", () => {
      if (!isActive() || !el.error) return;
      this.errorCb(MEDIA_ERRORS[el.error.code] ?? "The file couldn't be played.");
    });
    el.addEventListener("durationchange", () => {
      if (isActive() && Number.isFinite(el.duration) && el.duration > 0) this.durationCb(el.duration * 1000);
    });
    return el;
  }
}

function waitForMetadata(el: HTMLAudioElement): Promise<void> {
  if (el.error) return Promise.reject(new Error(MEDIA_ERRORS[el.error.code] ?? "The file couldn't be loaded."));
  if (el.readyState >= HTMLMediaElement.HAVE_METADATA) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const done = () => {
      el.removeEventListener("loadedmetadata", onLoaded);
      el.removeEventListener("error", onError);
    };
    const onLoaded = () => {
      done();
      resolve();
    };
    const onError = () => {
      done();
      reject(new Error(MEDIA_ERRORS[el.error?.code ?? 0] ?? "The file couldn't be loaded."));
    };
    el.addEventListener("loadedmetadata", onLoaded);
    el.addEventListener("error", onError);
  });
}
