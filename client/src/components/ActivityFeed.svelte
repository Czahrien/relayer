<script lang="ts">
  import type { ActivityEntry } from "@listening-room/shared";

  let { entries, serverNow }: { entries: ActivityEntry[]; serverNow: () => number } = $props();
  let open = $state(true);

  const recent = $derived([...entries].reverse().slice(0, 30));

  let now = $state(0);
  $effect(() => {
    now = serverNow();
    const timer = setInterval(() => (now = serverNow()), 30_000);
    return () => clearInterval(timer);
  });

  function ago(at: number): string {
    const s = Math.max(0, Math.round((now - at) / 1000));
    if (s < 60) return "just now";
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min ago`;
    return `${Math.round(m / 60)} h ago`;
  }
</script>

<section class="activity">
  <button class="toggle" type="button" aria-expanded={open} onclick={() => (open = !open)}>
    <h2>Activity</h2>
    <span class="chevron" class:open aria-hidden="true">
      <svg width="18" height="18" viewBox="0 0 24 24"><path d="M6 9.5l6 6 6-6" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" /></svg>
    </span>
  </button>
  {#if open}
    {#if recent.length === 0}
      <p class="empty">Nothing yet.</p>
    {:else}
      <ul>
        {#each recent as entry, i (`${entry.at}-${i}`)}
          <li>
            <span class="text">{#if entry.by}<b>{entry.by}</b>{" "}{/if}{entry.text}</span>
            <time datetime={new Date(entry.at).toISOString()}>{ago(entry.at)}</time>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</section>

<style>
  .activity {
    display: grid;
    gap: 4px;
  }

  .toggle {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: var(--tap);
    padding: 0;
    border: 0;
    border-bottom: 1px solid var(--line);
    background: none;
    text-align: left;
  }

  h2 {
    font-family: var(--font-display);
    font-size: 18px;
    font-weight: 560;
  }

  .chevron {
    color: var(--ink-3);
    rotate: -90deg;
    transition: rotate 150ms;
  }

  .chevron.open {
    rotate: 0deg;
  }

  ul {
    display: grid;
    gap: 2px;
    max-height: 240px;
    margin: 0;
    padding: 4px 0 0;
    overflow-y: auto;
    list-style: none;
  }

  li {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    padding: 4px 0;
    color: var(--ink-2);
    font-size: 14px;
  }

  .text {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  b {
    color: var(--ink);
    font-weight: 600;
  }

  time {
    flex: none;
    color: var(--ink-3);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }

  .empty {
    padding: 8px 0;
    color: var(--ink-3);
    font-size: 14px;
  }
</style>
