<script lang="ts">
  import { effectivePositionAt } from "@listening-room/shared";
  import type { RoomClient } from "../lib/room.svelte.js";
  import Art from "./Art.svelte";
  import Icon from "./Icon.svelte";
  import ProgressBar from "./ProgressBar.svelte";

  let { client }: { client: RoomClient } = $props();

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

  function toggle() {
    client.send({ type: playing ? "pause" : "play" });
  }
</script>

<section class="now-playing" aria-label="Now playing">
  <div class="art-frame" class:empty={!item}>
    {#if item}
      <Art title={item.title} artUrl={item.artUrl} />
    {:else}
      <div class="idle-art" aria-hidden="true">
        <div class="groove"></div>
      </div>
    {/if}
  </div>

  {#if item && pb}
    <div class="details">
      <p class="source">
        <Icon name={item.kind === "youtube" ? "youtube" : "file"} size={16} />
        {item.kind === "youtube" ? "YouTube" : "File"} · Added by {item.addedBy}
      </p>
      <h2 class="title">{item.title}</h2>
      {#if item.artist || item.album}
        <p class="byline">
          {item.artist ?? ""}{item.artist && item.album ? " — " : ""}{#if item.album}<i>{item.album}</i>{/if}
        </p>
      {/if}
      {#if pb.state === "waiting"}
        <p class="state">Waiting for upload…</p>
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
      <p class="state">The queue is empty. Drop some music here or paste a YouTube link.</p>
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

  .volume {
    display: flex;
    align-items: center;
    gap: 4px;
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
