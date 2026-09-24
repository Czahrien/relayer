<script lang="ts">
  import { onDestroy } from "svelte";
  import { RoomClient } from "../lib/room.svelte.js";
  import { getClientId } from "../lib/storage.js";
  import Header from "./Header.svelte";
  import JoinOverlay from "./JoinOverlay.svelte";

  let { roomId }: { roomId: string } = $props();
  let client: RoomClient | null = $state(null);

  function join(name: string) {
    const c = new RoomClient(roomId, getClientId(), name);
    c.start();
    client = c;
  }

  onDestroy(() => client?.destroy());
</script>

{#if !client}
  <JoinOverlay {roomId} onjoin={join} />
{:else}
  <div class="page">
    <Header
      {roomId}
      listeners={client.snapshot?.listeners ?? []}
      presence={client.presence}
      selfId={client.clientId}
    />
    {#if client.hasConnected && !client.connected}
      <div class="banner" role="status">Reconnecting…</div>
    {/if}
    <main class="layout"></main>
  </div>
{/if}

<style>
  .page {
    display: flex;
    flex-direction: column;
    min-height: 100dvh;
  }

  .banner {
    padding: 8px var(--gutter);
    background: var(--accent-soft);
    color: var(--ink);
    font-size: 14px;
    text-align: center;
  }

  .layout {
    flex: 1;
  }
</style>
