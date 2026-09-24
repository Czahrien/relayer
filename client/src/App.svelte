<script lang="ts">
  import Landing from "./components/Landing.svelte";
  import RoomPage from "./components/RoomPage.svelte";
  import Toasts from "./components/Toasts.svelte";

  let path = $state(location.pathname);
  const roomId = $derived(/^\/r\/([A-Za-z0-9_-]{1,64})\/?$/.exec(path)?.[1] ?? null);
  const isStart = $derived(/^\/start\/?$/.test(path));

  // Anything else goes to the start page with a full navigation (not
  // pushState), so a proxy guarding /start gets to see the request.
  $effect(() => {
    if (!roomId && !isStart) location.replace("/start");
  });
</script>

<svelte:window onpopstate={() => (path = location.pathname)} />

{#if roomId}
  {#key roomId}
    <RoomPage {roomId} />
  {/key}
{:else if isStart}
  <Landing />
{/if}
<Toasts />
