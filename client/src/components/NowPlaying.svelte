<script lang="ts">
  import { effectivePositionAt, youtubeWatchUrl } from "@relayer/shared";
  import { inDiscord } from "../lib/discord.js";
  import type { RoomClient } from "../lib/room.svelte.js";
  import Art from "./Art.svelte";
  import Icon from "./Icon.svelte";
  import ProgressBar from "./ProgressBar.svelte";

  let { client, theater = $bindable(false) }: { client: RoomClient; theater?: boolean } = $props();

  const SOURCE = {
    file: { icon: "file", label: "File" },
    library: { icon: "library", label: "Library" },
    youtube: { icon: "youtube", label: "YouTube" },
  } as const;

  let now = $state(0);
  $effect(() => {
    now = client.serverNow();
    const timer = setInterval(() => (now = client.serverNow()), 250);
    return () => clearInterval(timer);
  });

  const snap = $derived(client.snapshot);
  const pb = $derived(snap?.playback ?? null);
  const item = $derived(pb && snap ? snap.items[snap.currentIndex] : undefined);
  const position = $derived(pb && item ? effectivePositionAt(pb, now, item.durationMs) : 0);
  const playing = $derived(pb?.state === "playing");
  const canPrevious = $derived((snap?.items.length ?? 0) > 0);
  // YouTube can't play inside Discord (SPEC §15), so show its art rather than an empty black frame.
  const showVideo = $derived(item?.kind === "youtube" && item.status === "ready" && !inDiscord);

  let ytHost: HTMLDivElement | undefined = $state();
  $effect(() => {
    client.youtubePlayer.attach(ytHost ?? null);
  });

  // Fullscreen goes on our frame, not the iframe, so the embed isn't reloaded.
  // iPhone Safari only allows fullscreen on <video>, so it gets no button.
  const canFullscreen = document.fullscreenEnabled;
  let frame: HTMLDivElement | undefined = $state();

  export function toggleFullscreen() {
    if (!frame || !canFullscreen) return;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else if (showVideo) void frame.requestFullscreen().catch(() => {});
  }

  // A file or library track after a video would otherwise fill the screen.
  $effect(() => {
    if (!showVideo && frame && document.fullscreenElement === frame) void document.exitFullscreen().catch(() => {});
  });

  function toggle() {
    client.send({ type: playing ? "pause" : "play" });
  }
</script>

<section class="now-playing" aria-label="Now playing">
  <div class="art-frame" class:empty={!item} class:video-frame={showVideo} bind:this={frame}>
    <!-- The embed lives here permanently so the iframe survives track changes.
         Nothing may be drawn on top of it (YouTube's terms). -->
    <div class="video" class:shown={showVideo} bind:this={ytHost}></div>
    {#if item && !showVideo}
      <Art title={item.title} artUrl={item.artUrl} />
    {:else if !item}
      <div class="idle-art" aria-hidden="true">
        <div class="groove"></div>
      </div>
    {/if}
  </div>

  {#if item && pb}
    <div class="details">
      <p class="source">
        <Icon name={SOURCE[item.kind].icon} size={16} />
        {SOURCE[item.kind].label} · Added by {item.addedBy}
      </p>
      <h2 class="title">{item.title}</h2>
      {#if item.artist || item.album}
        <p class="byline">
          {item.artist ?? ""}{item.artist && item.album ? " — " : ""}{#if item.album}<i>{item.album}</i>{/if}
        </p>
      {/if}
      {#if item.kind === "youtube" && item.youtubeId}
        <a class="watch" href={youtubeWatchUrl(item.youtubeId)} target="_blank" rel="noopener noreferrer">
          Watch on YouTube <Icon name="external" size={16} />
        </a>
      {/if}
      {#if pb.state === "waiting"}
        <p class="state">Waiting for upload…</p>
      {/if}
      {#if showVideo && client.youtubeNeedsTap && pb.state === "playing"}
        <p class="state hint">Tap the video to start</p>
      {/if}
    </div>

    <ProgressBar
      positionMs={position}
      durationMs={item.durationMs}
      disabled={pb.state === "waiting"}
      onseek={(ms) => client.send({ type: "seek", positionMs: Math.round(ms) })}
    />
  {:else}
    <div class="details">
      <h2 class="title quiet">Nothing playing</h2>
      {#if (snap?.items.length ?? 0) > 0}
        <p class="state">The queue finished. Pick a track to hear it again, or add more.</p>
      {:else}
        <p class="state">The queue is empty. Drop some music here or paste a YouTube link.</p>
      {/if}
    </div>
  {/if}

  <div class="controls">
    <div class="transport">
      <button
        class="icon-btn"
        type="button"
        aria-label="Restart"
        title="Restart"
        disabled={!item || pb?.state === "waiting"}
        onclick={() => client.send({ type: "restart" })}
      >
        <Icon name="restart" size={20} />
      </button>
      <button
        class="icon-btn"
        type="button"
        aria-label="Previous"
        title="Previous"
        disabled={!canPrevious}
        onclick={() => client.send({ type: "previous" })}
      >
        <Icon name="previous" />
      </button>
      <button
        class="play"
        type="button"
        aria-label={playing ? "Pause" : "Play"}
        title={playing ? "Pause" : "Play"}
        disabled={!item || pb?.state === "waiting"}
        onclick={toggle}
      >
        <Icon name={playing ? "pause" : "play"} size={26} />
      </button>
      <button
        class="icon-btn"
        type="button"
        aria-label="Next"
        title="Next"
        disabled={!item}
        onclick={() => client.send({ type: "next" })}
      >
        <Icon name="next" />
      </button>
    </div>

    <div class="volume">
      {#if showVideo}
        <button
          class="icon-btn theater-btn"
          type="button"
          aria-label="Theater mode"
          title="Theater mode (T)"
          aria-pressed={theater}
          onclick={() => (theater = !theater)}
        >
          <Icon name="theater" size={20} />
        </button>
        {#if canFullscreen}
          <button
            class="icon-btn"
            type="button"
            aria-label="Fullscreen"
            title="Fullscreen (F)"
            onclick={toggleFullscreen}
          >
            <Icon name="fullscreen" size={20} />
          </button>
        {/if}
      {/if}
      <button
        class="icon-btn"
        type="button"
        aria-label={client.muted ? "Unmute" : "Mute"}
        title={client.muted ? "Unmute" : "Mute"}
        aria-pressed={client.muted}
        onclick={() => client.toggleMute()}
      >
        <Icon name={client.muted || client.volume === 0 ? "mute" : "volume"} size={20} />
      </button>
      <input
        type="range"
        min="0"
        max="1"
        step="0.01"
        aria-label="Volume"
        value={client.muted ? 0 : client.volume}
        style:--level="{(client.muted ? 0 : client.volume) * 100}%"
        oninput={(e) => client.setVolume(Number(e.currentTarget.value))}
      />
    </div>
  </div>
</section>

<style>
  .now-playing {
    display: grid;
    gap: 20px;
    align-content: start;
  }

  .art-frame {
    position: relative;
    width: 100%;
    /* Large, but leave room for the controls on short screens. */
    max-width: min(560px, max(260px, 100dvh - 380px));
    aspect-ratio: 1;
    border-radius: var(--radius-l);
    overflow: hidden;
    background: var(--surface-2);
    box-shadow: var(--art-shadow);
  }

  /* Videos are nearly always 16:9: fill the column's width, but keep the
     controls on screen by capping the height the same way as the art. */
  .art-frame.video-frame {
    max-width: max(320px, (100dvh - 380px) * 16 / 9);
    aspect-ratio: 16 / 9;
    background: #000;
  }

  .art-frame:fullscreen {
    width: 100%;
    max-width: none;
    height: 100%;
    aspect-ratio: auto;
    border-radius: 0;
    box-shadow: none;
  }

  .video {
    position: absolute;
    inset: 0;
    visibility: hidden;
    background: #000;
  }

  .video.shown {
    visibility: visible;
  }

  .video :global(iframe) {
    display: block;
    width: 100%;
    height: 100%;
    border: 0;
  }

  .hint {
    color: var(--accent);
    font-weight: 560;
  }

  .art-frame.empty {
    box-shadow: none;
    background: var(--surface-2);
  }

  .idle-art {
    display: grid;
    place-items: center;
    height: 100%;
  }

  .groove {
    width: 62%;
    aspect-ratio: 1;
    border-radius: 50%;
    background:
      radial-gradient(circle, var(--surface-2) 0 7%, var(--surface-3) 7.5% 30%, transparent 30.5%),
      repeating-radial-gradient(circle, var(--surface-3) 0 1px, transparent 1px 5px);
    opacity: 0.8;
  }

  .details {
    display: grid;
    gap: 4px;
    min-width: 0;
  }

  .source {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--ink-3);
    font-size: 13px;
  }

  .title {
    font-family: var(--font-display);
    font-size: clamp(26px, 3.4vw, 38px);
    font-weight: 560;
    line-height: 1.1;
    letter-spacing: -0.015em;
    overflow-wrap: anywhere;
    text-wrap: balance;
  }

  .title.quiet {
    color: var(--ink-2);
  }

  .byline {
    color: var(--ink-2);
    font-size: 16px;
  }

  .watch {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    justify-self: start;
    min-height: 36px;
    color: var(--ink-2);
    font-size: 14px;
    text-decoration: underline;
    text-decoration-color: var(--line);
    text-underline-offset: 3px;
  }

  .watch:hover {
    color: var(--ink);
    text-decoration-color: currentColor;
  }

  .state {
    color: var(--ink-2);
  }

  .controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 12px 24px;
  }

  .transport {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .play {
    display: grid;
    place-items: center;
    width: 60px;
    height: 60px;
    border: 0;
    border-radius: 50%;
    background: var(--ink);
    color: var(--bg);
    transition: background-color 120ms, scale 120ms;
  }

  .play:hover:not(:disabled) {
    background: var(--accent);
    color: var(--accent-ink);
  }

  .play:active:not(:disabled) {
    scale: 0.96;
  }

  .play:disabled {
    opacity: 0.35;
  }

  .theater-btn[aria-pressed="true"] {
    color: var(--accent);
  }

  /* Below 900px the layout is already one column. */
  @media (max-width: 899px) {
    .theater-btn {
      display: none;
    }
  }

  .volume {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  /* Phones held upright: the height-based cap above is for desktops; fill the width instead. */
  @media (max-width: 899px) and (orientation: portrait) {
    .art-frame {
      max-width: 560px;
    }

    .art-frame.video-frame {
      max-width: none;
    }
  }

  /* Short landscape screens (phones on their side, Discord's picture-in-picture):
     art beside the title, progress, and controls, so they stay on screen. */
  @media (orientation: landscape) and (max-height: 500px) {
    .now-playing {
      grid-template-columns: auto minmax(0, 1fr);
      gap: 4px 20px;
      align-items: center;
    }

    .art-frame:not(:fullscreen) {
      grid-row: span 3;
      width: 180px;
      max-width: none;
    }

    /* YouTube's embed must stay at least 200px tall (§6.7). */
    .art-frame.video-frame:not(:fullscreen) {
      width: 356px;
    }

    .title {
      display: -webkit-box;
      overflow: hidden;
      font-size: 24px;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 2;
      line-clamp: 2;
    }
  }

  /* Discord's picture-in-picture view is a fixed frame of about 480×270, with
     nothing else on the page (RoomPage): art as tall as the frame, details trimmed. */
  @media (max-height: 320px) {
    :global(html.discord) .now-playing {
      gap: 4px 16px;
      align-content: center;
    }

    :global(html.discord) .art-frame:not(:fullscreen) {
      width: calc(100dvh - 24px);
      border-radius: var(--radius);
    }

    :global(html.discord) .title {
      font-size: 20px;
    }

    :global(html.discord) .byline,
    :global(html.discord) .state {
      overflow: hidden;
      font-size: 14px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    :global(html.discord) .source,
    :global(html.discord) .watch,
    :global(html.discord) .volume {
      display: none;
    }

    :global(html.discord) .play {
      width: 44px;
      height: 44px;
    }
  }

  input[type="range"] {
    width: 120px;
    height: 28px;
    margin: 0;
    background: transparent;
    appearance: none;
    cursor: pointer;
  }

  input[type="range"]::-webkit-slider-runnable-track {
    height: 4px;
    border-radius: 2px;
    background: linear-gradient(to right, var(--ink-2) var(--level), var(--surface-3) var(--level));
  }

  input[type="range"]::-moz-range-track {
    height: 4px;
    border-radius: 2px;
    background: linear-gradient(to right, var(--ink-2) var(--level), var(--surface-3) var(--level));
  }

  input[type="range"]::-webkit-slider-thumb {
    width: 14px;
    height: 14px;
    margin-top: -5px;
    border: 0;
    border-radius: 50%;
    background: var(--ink);
    appearance: none;
  }

  input[type="range"]::-moz-range-thumb {
    width: 14px;
    height: 14px;
    border: 0;
    border-radius: 50%;
    background: var(--ink);
  }
</style>
