<script lang="ts">
  import Landing from "./components/Landing.svelte";
  import RoomPage from "./components/RoomPage.svelte";
  import Toasts from "./components/Toasts.svelte";
  import { inDiscord, startActivity } from "./lib/discord.js";

  let path = $state(location.pathname);
  const roomId = $derived(/^\/r\/([A-Za-z0-9_-]{1,64})\/?$/.exec(path)?.[1] ?? null);
  const isStart = $derived(/^\/start\/?$/.test(path));

  // Anything else goes to the start page with a full navigation (not
  // pushState), so a proxy guarding /start gets to see the request.
  $effect(() => {
    if (!inDiscord && !roomId && !isStart) location.replace("/start");
  });
</script>

<svelte:window onpopstate={() => (path = location.pathname)} />

{#if inDiscord}
  <!-- The Activity's room comes from Discord, not the URL (SPEC §15). -->
  {#await startActivity()}
    <p class="status">Connecting to Discord…</p>
  {:then activity}
    <RoomPage roomId={activity.roomId} {activity} />
  {:catch error}
    <p class="status">{error instanceof Error ? error.message : "Couldn't start Relayer."}</p>
  {/await}
{:else if roomId}
  {#key roomId}
    <RoomPage {roomId} />
  {/key}
{:else if isStart}
  <Landing />
{/if}
<Toasts />

<style>
  .status {
    margin: 48px var(--gutter);
    color: var(--ink-2);
    text-align: center;
  }
</style>
