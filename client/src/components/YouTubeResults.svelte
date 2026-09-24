<script lang="ts">
  import { formatTime, type YouTubeResult } from "@relayer/shared";
  import type { RoomClient } from "../lib/room.svelte.js";
  import Icon from "./Icon.svelte";

  let { client, results }: { client: RoomClient; results: YouTubeResult[] } = $props();
</script>

<div class="results" aria-live="polite">
  {#if results.length === 0}
    <p class="empty">No YouTube videos that can play here match.</p>
  {:else}
    <ul>
      {#each results as video (video.youtubeId)}
        <li class="row">
          <span class="thumb">
            {#if video.thumbnail}<img src={video.thumbnail} alt="" loading="lazy" />{/if}
          </span>
          <span class="text">
            <span class="title">{video.title}</span>
            {#if video.channel}<span class="meta">{video.channel}</span>{/if}
          </span>
          <span class="duration">{formatTime(video.durationMs)}</span>
          <div class="actions">
            <button
              class="icon-btn"
              type="button"
              aria-label="Play “{video.title}” next"
              title="Play next"
              onclick={() => client.addYoutubeResult(video, "next")}
            >
              <Icon name="queueNext" size={19} />
            </button>
            <button
              class="icon-btn add"
              type="button"
              aria-label="Add “{video.title}” to the queue"
              title="Add to queue"
              onclick={() => client.addYoutubeResult(video, "end")}
            >
              <Icon name="plus" size={20} />
            </button>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .results {
    max-height: min(60vh, 560px);
    overflow-y: auto;
    padding: 12px;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--surface);
    overscroll-behavior: contain;
  }

  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .empty {
    color: var(--ink-3);
    font-size: 14px;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 56px;
    border-radius: var(--radius-s);
  }

  .row:hover {
    background: var(--surface-2);
  }

  .thumb {
    flex: none;
    width: 71px;
    height: 40px;
    margin-left: 4px;
    border-radius: 5px;
    overflow: hidden;
    background: var(--surface-2);
  }

  .thumb img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .text {
    display: grid;
    flex: 1;
    min-width: 0;
  }

  .title,
  .meta {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .title {
    font-weight: 560;
  }

  .meta {
    color: var(--ink-3);
    font-size: 13px;
  }

  .duration {
    flex: none;
    color: var(--ink-3);
    font-size: 13px;
    font-variant-numeric: tabular-nums;
  }

  .actions {
    display: flex;
    flex: none;
  }

  .actions .icon-btn {
    width: 40px;
    height: 40px;
  }

  .actions .add {
    color: var(--accent);
  }
</style>
