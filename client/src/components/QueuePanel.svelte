<script lang="ts">
  import { formatTime, positionAt, youtubeWatchUrl, type QueueItem } from "@listening-room/shared";
  import { copyText } from "../lib/clipboard.js";
  import type { RoomClient } from "../lib/room.svelte.js";
  import { toast } from "../lib/toasts.svelte.js";
  import Art from "./Art.svelte";
  import Icon from "./Icon.svelte";

  let { client }: { client: RoomClient } = $props();

  const snap = $derived(client.snapshot);
  const items = $derived(snap?.items ?? []);
  const currentIndex = $derived(snap?.currentIndex ?? 0);
  const idle = $derived(currentIndex >= items.length);
  const playing = $derived(snap?.playback?.state === "playing");

  let menuFor = $state<string | null>(null);
  let confirmingClear = $state(false);

  // ---- Remaining time ----
  let now = $state(0);
  $effect(() => {
    now = client.serverNow();
    const timer = setInterval(() => (now = client.serverNow()), 1000);
    return () => clearInterval(timer);
  });

  const remaining = $derived.by(() => {
    let total = 0;
    let unknown = false;
    for (let i = currentIndex; i < items.length; i++) {
      const item = items[i]!;
      if (item.status === "error") continue;
      if (item.durationMs === undefined) {
        unknown = true;
        continue;
      }
      total += item.durationMs;
      if (i === currentIndex && snap?.playback) {
        total -= Math.min(item.durationMs, Math.max(0, positionAt(snap.playback, now)));
      }
    }
    return { total, unknown };
  });

  function statusText(item: QueueItem): string {
    if (item.status === "uploading") {
      const p = client.uploadProgress[item.id];
      return p === undefined ? "uploading…" : `${Math.round(p * 100)}%`;
    }
    if (item.status === "error") return item.error ?? "Can't play";
    return formatTime(item.durationMs);
  }

  // ---- Drag to reorder (pointer events, so touch works too) ----
  let drag = $state<{ id: string; pointerId: number; startY: number; dy: number; from: number; to: number } | null>(
    null,
  );
  let rowHeight = 0;

  function startDrag(event: PointerEvent, item: QueueItem, index: number) {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    rowHeight = handle.closest("li")?.getBoundingClientRect().height ?? 56;
    drag = { id: item.id, pointerId: event.pointerId, startY: event.clientY, dy: 0, from: index, to: index };
    menuFor = null;
  }

  function moveDrag(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const dy = event.clientY - drag.startY;
    // Only upcoming positions are valid targets.
    const to = Math.min(items.length - 1, Math.max(currentIndex + 1, drag.from + Math.round(dy / rowHeight)));
    drag = { ...drag, dy, to };
  }

  function endDrag(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const { id, from, to } = drag;
    drag = null;
    if (to !== from) client.send({ type: "move", itemId: id, toIndex: to });
  }

  /** Visual offset for rows displaced by the dragged one. */
  function shiftFor(index: number): number {
    if (!drag || index === drag.from) return 0;
    if (drag.from < index && index <= drag.to) return -rowHeight;
    if (drag.to <= index && index < drag.from) return rowHeight;
    return 0;
  }

  function onHandleKey(event: KeyboardEvent, item: QueueItem, index: number) {
    const delta = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
    if (!delta) return;
    event.preventDefault();
    event.stopPropagation();
    const to = index + delta;
    if (to <= currentIndex || to >= items.length) return;
    client.send({ type: "move", itemId: item.id, toIndex: to });
  }

  async function copyLink(url: string) {
    menuFor = null;
    toast((await copyText(url)) ? "Link copied." : "Couldn't copy the link.", "info", 2500);
  }

  function onWindowPointerDown(event: PointerEvent) {
    if (menuFor && !(event.target as HTMLElement).closest(".menu, .menu-button")) menuFor = null;
  }

  function onWindowKey(event: KeyboardEvent) {
    if (event.key === "Escape") {
      menuFor = null;
      confirmingClear = false;
    }
  }
</script>

<svelte:window onpointerdown={onWindowPointerDown} onkeydown={onWindowKey} />

<section class="queue" aria-labelledby="queue-title">
  <div class="head">
    <h2 id="queue-title">Queue</h2>
  </div>

  {#if items.length === 0}
    <p class="empty">Nothing here yet. Add files, a folder, or a YouTube link.</p>
  {:else}
    <ol class:dragging={drag !== null}>
      {#each items as item, index (item.id)}
        {@const isCurrent = index === currentIndex}
        {@const isHistory = index < currentIndex}
        {@const isUpcoming = index > currentIndex}
        {#if index === currentIndex && index > 0}
          <li class="divider" aria-hidden="true"></li>
        {/if}
        <li
          class="row"
          class:current={isCurrent}
          class:history={isHistory}
          class:error={item.status === "error"}
          class:lifted={drag?.id === item.id}
          class:menu-open={menuFor === item.id}
          style:translate={drag ? `0 ${drag.id === item.id ? drag.dy : shiftFor(index)}px` : undefined}
        >
          <button
            class="main"
            type="button"
            onclick={() => client.send({ type: "jump", itemId: item.id })}
            disabled={item.status === "error"}
            aria-current={isCurrent ? "true" : undefined}
            aria-label="{isCurrent ? 'Now playing: ' : isHistory ? 'Played: ' : 'Play '}{item.title}{item.artist
              ? ` by ${item.artist}`
              : ''}"
          >
            <span class="thumb">
              <Art title={item.title} artUrl={item.artUrl} size="small" />
              {#if isCurrent && playing}
                <span class="eq" aria-hidden="true"><i></i><i></i><i></i></span>
              {/if}
            </span>
            <span class="text">
              <span class="title">{item.title}</span>
              <span class="meta">
                {#if item.kind === "youtube"}<Icon name="youtube" size={13} />{/if}
                {item.artist ?? (item.kind === "youtube" ? "YouTube" : "Unknown artist")} · {item.addedBy}
              </span>
            </span>
            <span class="status" class:uploading={item.status === "uploading"} title={item.error}>
              {statusText(item)}
            </span>
          </button>

          {#if isUpcoming}
            <span
              class="handle"
              role="button"
              tabindex="0"
              aria-label="Reorder {item.title}. Use the up and down arrow keys."
              onpointerdown={(e) => startDrag(e, item, index)}
              onpointermove={moveDrag}
              onpointerup={endDrag}
              onpointercancel={endDrag}
              onkeydown={(e) => onHandleKey(e, item, index)}
            >
              <Icon name="grip" size={18} />
            </span>
          {/if}

          <div class="menu-wrap">
            <button
              class="icon-btn menu-button"
              type="button"
              aria-label="More actions for {item.title}"
              aria-haspopup="menu"
              aria-expanded={menuFor === item.id}
              onclick={() => (menuFor = menuFor === item.id ? null : item.id)}
            >
              <Icon name="more" size={20} />
            </button>
            {#if menuFor === item.id}
              <div class="menu" role="menu">
                {#if item.kind === "youtube" && item.youtubeId}
                  {@const watchUrl = youtubeWatchUrl(item.youtubeId)}
                  <a role="menuitem" href={watchUrl} target="_blank" rel="noopener noreferrer" onclick={() => (menuFor = null)}>
                    <Icon name="external" size={18} /> Open on YouTube
                  </a>
                  <button role="menuitem" type="button" onclick={() => copyLink(watchUrl)}>
                    <Icon name="copy" size={18} /> Copy link
                  </button>
                {/if}
                {#if !isCurrent && item.status !== "error"}
                  <button
                    role="menuitem"
                    type="button"
                    onclick={() => {
                      client.send({ type: "playNext", itemId: item.id });
                      menuFor = null;
                    }}
                  >
                    <Icon name="queueNext" size={18} /> Play next
                  </button>
                {/if}
                <button
                  role="menuitem"
                  type="button"
                  class="danger"
                  onclick={() => {
                    client.send({ type: "remove", itemId: item.id });
                    menuFor = null;
                  }}
                >
                  <Icon name="trash" size={18} /> Remove
                </button>
              </div>
            {/if}
          </div>
        </li>
      {/each}
      {#if idle}
        <li class="divider labeled"><span>End of queue</span></li>
      {/if}
    </ol>
  {/if}

  <footer>
    <p class="summary">
      {items.length}
      {items.length === 1 ? "item" : "items"}
      {#if !idle}
        · {formatTime(remaining.total)}{remaining.unknown ? "+" : ""} remaining
      {/if}
    </p>
    {#if items.length > 0}
      {#if confirmingClear}
        <div class="confirm" role="group" aria-label="Confirm clearing the queue">
          <span>Clear everything?</span>
          <button class="btn small" type="button" onclick={() => (confirmingClear = false)}>Cancel</button>
          <button
            class="btn small danger"
            type="button"
            onclick={() => {
              client.send({ type: "clear" });
              confirmingClear = false;
            }}
          >
            Clear queue
          </button>
        </div>
      {:else}
        <button class="btn small" type="button" onclick={() => (confirmingClear = true)}>Clear queue</button>
      {/if}
    {/if}
  </footer>
</section>

<style>
  .queue {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--line);
  }

  h2 {
    font-family: var(--font-display);
    font-size: 22px;
    font-weight: 560;
  }

  .empty {
    padding: 32px 0;
    color: var(--ink-3);
  }

  ol {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  ol.dragging {
    user-select: none;
  }

  .row {
    position: relative;
    display: flex;
    align-items: center;
    border-radius: var(--radius);
    background: var(--bg);
    transition: translate 160ms ease;
  }

  .row.menu-open {
    z-index: 3;
  }

  .row.lifted {
    z-index: 2;
    background: var(--surface);
    box-shadow: var(--shadow);
    transition: none;
  }

  .row:hover {
    background: var(--surface);
  }

  .row.current {
    background: var(--accent-soft);
  }

  .main {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
    min-height: 60px;
    padding: 8px 4px 8px 8px;
    border: 0;
    border-radius: var(--radius);
    background: none;
    text-align: left;
  }

  .main:disabled {
    cursor: default;
  }

  .history .main {
    opacity: 0.55;
  }

  .history:hover .main {
    opacity: 0.85;
  }

  .thumb {
    position: relative;
    flex: none;
    width: 44px;
    height: 44px;
    border-radius: var(--radius-s);
    overflow: hidden;
    background: var(--surface-2);
  }

  /* The small animated playing indicator. */
  .eq {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: flex-end;
    justify-content: center;
    gap: 3px;
    padding: 11px;
    background: rgb(0 0 0 / 0.45);
  }

  .eq i {
    width: 4px;
    height: 100%;
    border-radius: 1px;
    background: #fff;
    transform-origin: bottom;
    animation: eq 900ms ease-in-out infinite alternate;
  }

  .eq i:nth-child(2) {
    animation-delay: -300ms;
    animation-duration: 700ms;
  }

  .eq i:nth-child(3) {
    animation-delay: -600ms;
    animation-duration: 1100ms;
  }

  @keyframes eq {
    from {
      scale: 1 0.25;
    }
    to {
      scale: 1 1;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .eq i {
      animation: none;
      scale: 1 0.6;
    }
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

  .current .title {
    color: var(--ink);
  }

  .meta {
    display: flex;
    align-items: center;
    gap: 4px;
    color: var(--ink-3);
    font-size: 13px;
  }

  .status {
    flex: none;
    max-width: 40%;
    color: var(--ink-3);
    font-size: 13px;
    font-variant-numeric: tabular-nums;
    text-align: right;
    /* Error messages can be long; keep rows compact (full text is in the tooltip). */
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
  }

  .status.uploading {
    color: var(--accent);
  }

  .error .status {
    color: var(--bad);
  }

  .error .title {
    text-decoration: line-through;
    text-decoration-color: var(--ink-3);
  }

  .handle {
    display: grid;
    place-items: center;
    width: 32px;
    height: 44px;
    flex: none;
    border-radius: var(--radius-s);
    color: var(--ink-3);
    cursor: grab;
    touch-action: none;
  }

  .handle:hover {
    color: var(--ink);
  }

  .lifted .handle {
    cursor: grabbing;
  }

  .menu-wrap {
    position: relative;
    flex: none;
  }

  .menu-button {
    color: var(--ink-3);
  }

  .menu {
    position: absolute;
    z-index: 10;
    right: 4px;
    top: calc(100% - 4px);
    display: grid;
    min-width: 190px;
    padding: 6px;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--surface);
    box-shadow: var(--shadow);
  }

  .menu button,
  .menu a {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 40px;
    padding: 0 10px;
    border: 0;
    border-radius: var(--radius-s);
    background: none;
    color: inherit;
    font-size: 15px;
    text-align: left;
    text-decoration: none;
  }

  .menu button:hover,
  .menu a:hover {
    background: var(--surface-2);
  }

  .menu .danger {
    color: var(--bad);
  }

  .divider {
    height: 1px;
    margin: 6px 8px;
    background: var(--line);
  }

  .divider.labeled {
    display: flex;
    align-items: center;
    gap: 10px;
    height: auto;
    background: none;
    color: var(--ink-3);
    font-size: 13px;
  }

  .divider.labeled::after {
    content: "";
    flex: 1;
    height: 1px;
    background: var(--line);
  }

  footer {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px 16px;
    margin-top: 8px;
    padding-top: 12px;
    border-top: 1px solid var(--line);
  }

  .summary {
    color: var(--ink-3);
    font-size: 13px;
    font-variant-numeric: tabular-nums;
  }

  .confirm {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    font-size: 14px;
  }

  .btn.danger {
    background: var(--bad);
    border-color: var(--bad);
    color: #fff;
  }
</style>
