<script lang="ts">
  import Landing from "./components/Landing.svelte";
  import RoomPage from "./components/RoomPage.svelte";
  import Toasts from "./components/Toasts.svelte";

  let path = $state(location.pathname);
  const roomId = $derived(/^\/r\/([A-Za-z0-9_-]{1,64})\/?$/.exec(path)?.[1] ?? null);

  function navigate(to: string) {
    history.pushState(null, "", to);
    path = location.pathname;
  }
</script>

<svelte:window onpopstate={() => (path = location.pathname)} />

{#if roomId}
  {#key roomId}
    <RoomPage {roomId} />
  {/key}
{:else}
  <Landing {navigate} />
{/if}
<Toasts />
