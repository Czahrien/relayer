<script lang="ts">
  import type { RoomClient } from "../lib/room.svelte.js";

  let { client, onclose }: { client: RoomClient; onclose: () => void } = $props();

  interface Row {
    label: string;
    value: string;
  }

  let rows = $state<Row[]>([]);

  function ms(value: number | null | undefined, digits = 0): string {
    return value === null || value === undefined ? "—" : `${value.toFixed(digits)} ms`;
  }

  function sample(): Row[] {
    const stats = client.engine.stats;
    const player = client.engine.activePlayer;
    return [
      { label: "Clock offset", value: client.clock.synced ? ms(client.clock.offset, 1) : "not synced" },
      { label: "Best RTT", value: ms(client.clock.bestRtt, 1) },
      { label: "Drift", value: stats.driftMs === null ? "—" : `${stats.driftMs >= 0 ? "+" : ""}${stats.driftMs.toFixed(0)} ms` },
      { label: "Rate", value: stats.rate.toFixed(4) },
      { label: "Seek lead", value: ms(stats.seekLeadMs) },
      { label: "Player", value: `${player?.kind ?? "none"} · ${stats.state}${player?.isBuffering() ? " · buffering" : ""}` },
      { label: "Position", value: player ? ms(player.positionMs()) : "—" },
      { label: "Rev", value: String(client.snapshot?.rev ?? "—") },
      { label: "Last action", value: stats.lastAction || "—" },
    ];
  }

  $effect(() => {
    rows = sample();
    const timer = setInterval(() => (rows = sample()), 250);
    return () => clearInterval(timer);
  });
</script>

<aside class="debug" aria-label="Debug panel">
  <div class="head">
    <h2>Sync debug</h2>
    <button class="close" type="button" onclick={onclose} aria-label="Close debug panel">×</button>
  </div>
  <dl>
    {#each rows as row (row.label)}
      <dt>{row.label}</dt>
      <dd>{row.value}</dd>
    {/each}
  </dl>
  <p class="hint">Press D to toggle</p>
</aside>

<style>
  .debug {
    position: fixed;
    z-index: 30;
    right: 16px;
    bottom: 16px;
    width: 280px;
    padding: 12px 14px;
    border-radius: var(--radius);
    background: rgb(20 19 17 / 0.92);
    color: #eae4da;
    font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    box-shadow: var(--shadow);
  }

  .head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 6px;
  }

  h2 {
    font: inherit;
    font-weight: 700;
    color: #ff8a4c;
  }

  .close {
    width: 28px;
    height: 28px;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: inherit;
    font-size: 18px;
  }

  dl {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 2px 12px;
    margin: 0;
  }

  dt {
    color: #a39b8f;
  }

  dd {
    margin: 0;
    text-align: right;
    font-variant-numeric: tabular-nums;
    overflow-wrap: anywhere;
  }

  .hint {
    margin-top: 8px;
    color: #8a8378;
  }
</style>
