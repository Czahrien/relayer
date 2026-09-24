<script lang="ts">
  import type { ListenerHealth, Listener } from "@relayer/shared";
  import { tick } from "svelte";
  import Icon from "./Icon.svelte";

  let {
    roomId,
    listeners,
    presence,
    selfId,
  }: {
    roomId: string;
    listeners: Listener[];
    presence: Record<string, ListenerHealth>;
    selfId: string;
  } = $props();

  let copied = $state(false);
  let showUrl = $state(false);
  let urlField: HTMLInputElement | undefined = $state();
  const roomUrl = $derived(`${location.origin}/r/${roomId}`);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(roomUrl);
      copied = true;
      setTimeout(() => (copied = false), 2000);
    } catch {
      // The clipboard API needs HTTPS or localhost; show the URL selected for a manual copy.
      showUrl = true;
      await tick();
      urlField?.focus();
      urlField?.select();
    }
  }

  type Health = "good" | "fair" | "poor" | "unknown";

  function health(clientId: string): Health {
    const h = presence[clientId];
    if (!h) return "unknown";
    if (h.state === "buffering") return "poor";
    if (h.driftMs === null) return h.state === "loading" ? "unknown" : "good";
    const drift = Math.abs(h.driftMs);
    return drift <= 100 ? "good" : drift <= 500 ? "fair" : "poor";
  }

  const healthLabel: Record<Health, string> = {
    good: "in sync",
    fair: "slightly out of sync",
    poor: "out of sync or buffering",
    unknown: "sync unknown",
  };
</script>

<header>
  <div class="identity">
    <span class="mark" aria-hidden="true"></span>
    <div class="room">
      <span class="label">Room</span>
      <span class="room-id">{roomId}</span>
    </div>
    <button class="btn small" type="button" onclick={copyLink}>
      <Icon name={copied ? "check" : "link"} size={18} />
      {copied ? "Copied" : "Copy link"}
    </button>
  </div>
  {#if showUrl}
    <div class="manual-copy">
      <input
        bind:this={urlField}
        class="field"
        readonly
        value={roomUrl}
        aria-label="Room link. Copy it manually."
        onfocus={(e) => e.currentTarget.select()}
      />
      <button class="btn small" type="button" onclick={() => (showUrl = false)}>Done</button>
    </div>
  {/if}

  <ul class="listeners" aria-label="Listeners">
    {#each listeners as listener (listener.clientId)}
      {@const h = health(listener.clientId)}
      <li title="{listener.name}: {healthLabel[h]}">
        <span class="dot {h}" aria-hidden="true"></span>
        <span class="name">{listener.name}{listener.clientId === selfId ? " (you)" : ""}</span>
        <span class="visually-hidden">, {healthLabel[h]}</span>
      </li>
    {/each}
  </ul>
</header>

<style>
  header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 12px 24px;
    padding: 12px var(--gutter);
    border-bottom: 1px solid var(--line);
  }

  .identity {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
  }

  .mark {
    width: 22px;
    height: 22px;
    flex: none;
    border-radius: 50%;
    background: radial-gradient(circle, var(--bg) 0 8%, var(--accent) 9% 34%, var(--ink) 35%);
  }

  .room {
    display: grid;
    min-width: 0;
    line-height: 1.2;
  }

  .label {
    color: var(--ink-3);
    font-size: 12px;
  }

  .room-id {
    font-weight: 620;
    font-variant-numeric: tabular-nums;
    overflow-wrap: anywhere;
  }

  .manual-copy {
    display: flex;
    gap: 8px;
    order: 3;
    width: 100%;
  }

  .listeners {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .listeners li {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    max-width: 180px;
    padding: 4px 11px 4px 9px;
    border-radius: 999px;
    background: var(--surface-2);
    font-size: 13px;
  }

  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .dot {
    width: 8px;
    height: 8px;
    flex: none;
    border-radius: 50%;
    background: var(--ink-3);
  }

  .dot.good {
    background: var(--good);
  }

  .dot.fair {
    background: var(--warn);
  }

  .dot.poor {
    background: var(--bad);
  }
</style>
