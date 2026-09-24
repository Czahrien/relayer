import type { QueueItem } from "@listening-room/shared";
import { RecoverableError, type Player } from "./Player.js";

// The slice of the IFrame Player API we use.
interface YTPlayer {
  cueVideoById(id: string): void;
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  mute(): void;
  unMute(): void;
  setVolume(volume: number): void;
  destroy(): void;
}

interface YTNamespace {
  Player: new (
    el: HTMLElement,
    options: {
      width: string;
      height: string;
      videoId: string;
      playerVars: Record<string, string | number>;
      events: {
        onReady: () => void;
        onStateChange: (event: { data: number }) => void;
        onError: (event: { data: number }) => void;
      };
    },
  ) => YTPlayer;
}

declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

const State = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 } as const;
const LOAD_TIMEOUT_MS = 15_000;
const TAP_HINT_AFTER_MS = 2500;

const ERRORS: Record<number, string> = {
  2: "YouTube rejected the video ID.",
  5: "YouTube couldn't play this video in the browser.",
  100: "This video was removed or is private.",
  101: "This video can't be played outside YouTube.",
  150: "This video can't be played outside YouTube.",
};

let apiPromise: Promise<YTNamespace> | null = null;

/** Loads https://www.youtube.com/iframe_api once. */
function loadApi(): Promise<YTNamespace> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  apiPromise ??= new Promise((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      resolve(window.YT!);
    };
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.async = true;
    script.onerror = () => {
      apiPromise = null;
      reject(new RecoverableError("Couldn't load the YouTube player."));
    };
    document.head.append(script);
  });
  return apiPromise;
}

/**
 * Plays YouTube items through the IFrame Player API. The video stays visible
 * in the now-playing art area, as YouTube's terms require (§6.7).
 */
export class YouTubePlayer implements Player {
  readonly kind = "youtube" as const;
  private player: YTPlayer | null = null;
  /** The API object has no methods until onReady fires. */
  private ready = false;
  private host: HTMLElement | null = null;
  private hostWaiters: (() => void)[] = [];
  private state: number = State.UNSTARTED;
  private videoId: string | null = null;
  private cuedId: string | null = null;
  private created: Promise<void> | null = null;
  /** A seek requested before the video started; seekTo would start playback. */
  private pendingSeekMs: number | null = null;
  private volume = 1;
  private pendingLoad: { resolve: () => void; reject: (err: Error) => void } | null = null;
  private tapTimer: ReturnType<typeof setTimeout> | null = null;
  private endedCb = () => {};
  private errorCb = (_message: string, _recoverable: boolean) => {};
  private durationCb = (_ms: number) => {};

  /** Called when programmatic play seems blocked (iOS wants a tap on the video). */
  onNeedsTap: (needed: boolean) => void = () => {};

  attach(host: HTMLElement | null): void {
    this.host = host;
    if (host) for (const wake of this.hostWaiters.splice(0)) wake();
  }

  async load(item: QueueItem): Promise<void> {
    const id = item.youtubeId;
    if (!id) throw new Error("This item has no YouTube video ID.");
    this.pendingLoad?.resolve();
    this.pendingLoad = null;
    this.pendingSeekMs = null;
    this.videoId = id;

    await (this.created ??= this.create(id));
    if (this.videoId !== id) return; // superseded while the player was starting
    if (this.cuedId !== id) {
      const cued = new Promise<void>((resolve, reject) => {
        this.pendingLoad = { resolve, reject };
      });
      const timeout = setTimeout(() => this.settleLoad(), LOAD_TIMEOUT_MS);
      this.state = State.UNSTARTED;
      this.cuedId = id;
      this.player!.cueVideoById(id);
      try {
        await cued;
      } finally {
        clearTimeout(timeout);
      }
    }
    this.reportDuration();
  }

  /** Creates the embed with its first video already cued; resolves on onReady. */
  private async create(id: string): Promise<void> {
    const api = await loadApi();
    const host = await this.waitForHost();
    const mount = document.createElement("div");
    host.replaceChildren(mount);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new RecoverableError("YouTube didn't respond.")), LOAD_TIMEOUT_MS);
      this.player = new api.Player(mount, {
        width: "100%",
        height: "100%",
        videoId: id,
        playerVars: { controls: 0, disablekb: 1, rel: 0, playsinline: 1, origin: location.origin },
        events: {
          onReady: () => {
            clearTimeout(timeout);
            this.ready = true;
            this.cuedId = id;
            this.applyVolume();
            resolve();
          },
          onStateChange: (event) => this.handleState(event.data),
          onError: (event) => this.handleError(event.data),
        },
      });
    }).catch((err: unknown) => {
      this.created = null;
      throw err;
    });
  }

  play(): Promise<void> {
    const player = this.readyPlayer();
    if (!player) return Promise.resolve();
    if (this.pendingSeekMs !== null) {
      player.seekTo(this.pendingSeekMs / 1000, true); // also starts playback
      this.pendingSeekMs = null;
    } else {
      player.playVideo();
    }
    this.watchForTap();
    return Promise.resolve();
  }

  pause(): void {
    this.clearTapWatch();
    if (this.state === State.PLAYING || this.state === State.BUFFERING) this.readyPlayer()?.pauseVideo();
  }

  seek(ms: number): void {
    const player = this.readyPlayer();
    if (!player || this.state === State.UNSTARTED || this.state === State.CUED) {
      this.pendingSeekMs = ms;
      return;
    }
    player.seekTo(ms / 1000, true);
  }

  positionMs(): number {
    if (this.pendingSeekMs !== null) return this.pendingSeekMs;
    return (this.readyPlayer()?.getCurrentTime() ?? 0) * 1000;
  }

  setRate(_rate: number): void {
    // YouTube's rates are too coarse for nudging; the engine only seeks.
  }

  setVolume(v: number): void {
    this.volume = v;
    this.applyVolume();
  }

  isBuffering(): boolean {
    return this.state === State.BUFFERING;
  }

  isPaused(): boolean {
    return this.state !== State.PLAYING && this.state !== State.BUFFERING;
  }

  isEnded(): boolean {
    return this.state === State.ENDED;
  }

  onEnded(cb: () => void): void {
    this.endedCb = cb;
  }

  onError(cb: (message: string, recoverable: boolean) => void): void {
    this.errorCb = cb;
  }

  onDuration(cb: (ms: number) => void): void {
    this.durationCb = cb;
  }

  destroy(): void {
    this.clearTapWatch();
    this.readyPlayer()?.destroy();
    this.player = null;
    this.ready = false;
    this.created = null;
    this.videoId = this.cuedId = null;
  }

  private readyPlayer(): YTPlayer | null {
    return this.ready ? this.player : null;
  }

  private waitForHost(): Promise<HTMLElement> {
    if (this.host) return Promise.resolve(this.host);
    return new Promise((resolve) => this.hostWaiters.push(() => resolve(this.host!)));
  }

  private settleLoad(): void {
    this.pendingLoad?.resolve();
    this.pendingLoad = null;
  }

  private handleState(state: number): void {
    this.state = state;
    if (state === State.CUED) this.settleLoad();
    if (state === State.PLAYING || state === State.BUFFERING) this.clearTapWatch();
    if (state === State.ENDED) this.endedCb();
    this.reportDuration();
  }

  private handleError(code: number): void {
    const message = ERRORS[code] ?? `YouTube couldn't play this video (error ${code}).`;
    if (this.pendingLoad) {
      this.pendingLoad.reject(new Error(message));
      this.pendingLoad = null;
    } else {
      this.errorCb(message, false);
    }
  }

  private reportDuration(): void {
    const seconds = this.readyPlayer()?.getDuration() ?? 0;
    if (seconds > 0) this.durationCb(seconds * 1000);
  }

  private applyVolume(): void {
    const player = this.readyPlayer();
    if (!player) return;
    if (this.volume === 0) player.mute();
    else {
      player.unMute();
      player.setVolume(Math.round(this.volume * 100));
    }
  }

  private watchForTap(): void {
    if (this.tapTimer) return;
    this.tapTimer = setTimeout(() => {
      this.tapTimer = null;
      if (this.isPaused()) this.onNeedsTap(true);
    }, TAP_HINT_AFTER_MS);
  }

  private clearTapWatch(): void {
    if (this.tapTimer) clearTimeout(this.tapTimer);
    this.tapTimer = null;
    this.onNeedsTap(false);
  }
}
