<script lang="ts">
  import { formatTime } from "@relayer/shared";

  let {
    positionMs,
    durationMs,
    disabled = false,
    onseek,
  }: {
    positionMs: number;
    durationMs: number | undefined;
    disabled?: boolean;
    onseek: (ms: number) => void;
  } = $props();

  let track: HTMLDivElement | undefined = $state();
  /** Local preview while dragging or while keyboard steps are being coalesced. */
  let preview = $state<number | null>(null);
  let dragging = $state(false);
  let keyTimer: ReturnType<typeof setTimeout> | null = null;

  const seekable = $derived(!disabled && durationMs !== undefined && durationMs > 0);
  const shown = $derived(Math.min(preview ?? positionMs, durationMs ?? Number.POSITIVE_INFINITY));
  const fraction = $derived(seekable ? Math.min(1, Math.max(0, shown / durationMs!)) : 0);

  function positionFromPointer(event: PointerEvent): number {
    const rect = track!.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    return f * durationMs!;
  }

  function onPointerDown(event: PointerEvent) {
    if (!seekable || event.button !== 0) return;
    track!.setPointerCapture(event.pointerId);
    dragging = true;
    preview = positionFromPointer(event);
  }

  function onPointerMove(event: PointerEvent) {
    if (dragging) preview = positionFromPointer(event);
  }

  function onPointerUp(event: PointerEvent) {
    if (!dragging) return;
    dragging = false;
    const target = positionFromPointer(event);
    preview = null;
    onseek(target);
  }

  function onPointerCancel() {
    dragging = false;
    preview = null;
  }

  function onKeyDown(event: KeyboardEvent) {
    if (!seekable) return;
    const step: Record<string, number> = {
      ArrowLeft: -5000,
      ArrowDown: -5000,
      ArrowRight: 5000,
      ArrowUp: 5000,
      PageDown: -30_000,
      PageUp: 30_000,
    };
    let target: number;
    if (event.key in step) target = (preview ?? positionMs) + step[event.key]!;
    else if (event.key === "Home") target = 0;
    else if (event.key === "End") target = durationMs! - 1000;
    else return;
    event.preventDefault();
    event.stopPropagation();
    preview = Math.min(durationMs!, Math.max(0, target));
    // Coalesce held or repeated keys into one seek.
    if (keyTimer) clearTimeout(keyTimer);
    keyTimer = setTimeout(() => {
      keyTimer = null;
      if (preview !== null) onseek(preview);
      preview = null;
    }, 350);
  }
</script>

<div class="progress" class:disabled={!seekable}>
  <div
    bind:this={track}
    class="track"
    class:dragging
    role="slider"
    tabindex={seekable ? 0 : -1}
    aria-label="Seek"
    aria-valuemin={0}
    aria-valuemax={Math.round((durationMs ?? 0) / 1000)}
    aria-valuenow={Math.round(shown / 1000)}
    aria-valuetext="{formatTime(shown)} of {formatTime(durationMs)}"
    aria-disabled={!seekable}
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    onpointercancel={onPointerCancel}
    onkeydown={onKeyDown}
  >
    <div class="rail">
      <div class="fill" style:width="{fraction * 100}%"></div>
    </div>
    {#if seekable}
      <div class="thumb" style:left="{fraction * 100}%"></div>
    {/if}
  </div>
  <div class="times">
    <span>{formatTime(shown)}</span>
    <span>{formatTime(durationMs)}</span>
  </div>
</div>

<style>
  .progress {
    display: grid;
    gap: 2px;
  }

  .track {
    position: relative;
    display: flex;
    align-items: center;
    height: 28px;
    cursor: pointer;
    touch-action: none;
  }

  .disabled .track {
    cursor: default;
  }

  .track:focus-visible {
    outline-offset: 0;
    border-radius: 4px;
  }

  .rail {
    position: relative;
    width: 100%;
    height: 4px;
    border-radius: 2px;
    background: var(--surface-3);
    overflow: hidden;
    transition: height 120ms;
  }

  .track:hover .rail,
  .track.dragging .rail,
  .track:focus-visible .rail {
    height: 6px;
  }

  .fill {
    height: 100%;
    background: var(--ink);
  }

  .track:hover .fill,
  .track.dragging .fill {
    background: var(--accent);
  }

  .thumb {
    position: absolute;
    top: 50%;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--ink);
    translate: -50% -50%;
    scale: 0;
    transition: scale 120ms;
  }

  .track:hover .thumb,
  .track.dragging .thumb,
  .track:focus-visible .thumb {
    scale: 1;
    background: var(--accent);
  }

  @media (pointer: coarse) {
    .thumb {
      scale: 1;
    }
  }

  .times {
    display: flex;
    justify-content: space-between;
    color: var(--ink-3);
    font-size: 13px;
    font-variant-numeric: tabular-nums;
  }
</style>
