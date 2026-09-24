<script lang="ts">
  import { onDestroy } from "svelte";
  import { effectivePositionAt } from "@listening-room/shared";
  import { registerMediaSessionHandlers, updateMediaSession } from "../lib/mediaSession.js";
  import { collectFromDataTransfer, collectFromFileList, extractLinks } from "../lib/ingest/drop.js";
  import { RoomClient } from "../lib/room.svelte.js";
  import { getClientId } from "../lib/storage.js";
  import ActivityFeed from "./ActivityFeed.svelte";
  import AddControls from "./AddControls.svelte";
  import DebugPanel from "./DebugPanel.svelte";
  import DropOverlay from "./DropOverlay.svelte";
  import Header from "./Header.svelte";
  import JoinOverlay from "./JoinOverlay.svelte";
  import NowPlaying from "./NowPlaying.svelte";
  import QueuePanel from "./QueuePanel.svelte";
  import RoomMissing from "./RoomMissing.svelte";

  let { roomId }: { roomId: string } = $props();
  let client: RoomClient | null = $state(null);
  /** null while checking; a network failure counts as "exists" and lets the socket decide. */
  let exists = $state<boolean | null>(null);

  $effect(() => {
    fetch(`/api/rooms/${encodeURIComponent(roomId)}`).then(
      (response) => (exists = response.status !== 404),
      () => (exists = true),
    );
  });
  let dragDepth = $state(0);
  // D toggles it; ?debug opens it on devices without a keyboard.
  let showDebug = $state(new URLSearchParams(location.search).has("debug"));

  function join(name: string) {
    const c = new RoomClient(roomId, getClientId(), name);
    c.unlockAudio(); // still inside the Join click
    c.start();
    client = c;
  }

  onDestroy(() => {
    client?.destroy();
    document.title = "Listening Room";
  });

  const current = $derived.by(() => {
    const snap = client?.snapshot;
    const pb = snap?.playback ?? null;
    return { item: pb && snap ? snap.items[snap.currentIndex] : undefined, pb };
  });

  $effect(() => {
    const { item, pb } = current;
    document.title =
      item && pb?.state === "playing"
        ? `▶ ${item.title}${item.artist ? ` – ${item.artist}` : ""}`
        : item
          ? `${item.title} · Listening Room`
          : "Listening Room";
  });

  $effect(() => {
    if (!client) return;
    return registerMediaSessionHandlers(client);
  });

  $effect(() => {
    const { item, pb } = current;
    if (client) updateMediaSession(item, pb, client.serverNow());
  });

  function isEditable(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  }

  function carriesContent(event: DragEvent): boolean {
    const types = event.dataTransfer?.types ?? [];
    return types.includes("Files") || types.includes("text/uri-list") || types.includes("text/plain");
  }

  function onDragEnter(event: DragEvent) {
    if (!client || !carriesContent(event)) return;
    event.preventDefault();
    dragDepth++;
  }

  function onDragOver(event: DragEvent) {
    if (!client || !carriesContent(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  }

  function onDragLeave() {
    if (dragDepth > 0) dragDepth--;
  }

  function onDrop(event: DragEvent) {
    dragDepth = 0;
    if (!client || !event.dataTransfer) return;
    event.preventDefault();
    // collectFromDataTransfer grabs everything synchronously before awaiting.
    const request = collectFromDataTransfer(event.dataTransfer);
    const c = client;
    void request.then((r) => c.ingest(r));
  }

  function onPaste(event: ClipboardEvent) {
    if (!client || isEditable(event.target) || !event.clipboardData) return;
    const files = event.clipboardData.files;
    if (files.length > 0) {
      event.preventDefault();
      void client.ingest(collectFromFileList(files));
      return;
    }
    const links = extractLinks(event.clipboardData.getData("text/uri-list"), event.clipboardData.getData("text/plain"));
    if (links.length > 0) {
      event.preventDefault();
      void client.ingest({ files: [], links, skipped: 0 });
    }
  }

  /** Space on a focused control should activate that control, not play/pause. */
  function isControl(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    return !!el?.closest?.("button, a, [role=button], [role=slider], [role=menuitem], summary");
  }

  function onKeyDown(event: KeyboardEvent) {
    if (!client || event.defaultPrevented || isEditable(event.target)) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const { item, pb } = current;
    const seekBy = (delta: number) => {
      if (!item || !pb || pb.state === "waiting") return;
      const pos = effectivePositionAt(pb, client!.serverNow(), item.durationMs);
      client!.send({ type: "seek", positionMs: Math.round(Math.max(0, pos + delta)) });
    };

    switch (event.key) {
      case " ":
        if (isControl(event.target) || !pb || pb.state === "waiting") return;
        client.send({ type: pb.state === "playing" ? "pause" : "play" });
        break;
      case "ArrowLeft":
        if (event.shiftKey) client.send({ type: "previous" });
        else seekBy(-10_000);
        break;
      case "ArrowRight":
        if (event.shiftKey) {
          if (item) client.send({ type: "next" });
        } else seekBy(10_000);
        break;
      case "m":
      case "M":
        client.toggleMute();
        break;
      case "d":
      case "D":
        showDebug = !showDebug;
        break;
      default:
        return;
    }
    event.preventDefault();
  }
</script>

<svelte:window
  ondragenter={onDragEnter}
  ondragover={onDragOver}
  ondragleave={onDragLeave}
  ondrop={onDrop}
  onpaste={onPaste}
  onkeydown={onKeyDown}
/>

{#if exists === false || client?.missing}
  <RoomMissing />
{:else if exists === null}
  <!-- checking the room -->
{:else if !client}
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
    <main class="layout">
      <div class="left">
        <NowPlaying {client} />
      </div>
      <div class="right">
        <AddControls {client} />
        <QueuePanel {client} />
        <ActivityFeed entries={client.activity} serverNow={() => client!.serverNow()} />
      </div>
    </main>
  </div>
  <DropOverlay visible={dragDepth > 0} />
  {#if showDebug}
    <DebugPanel {client} onclose={() => (showDebug = false)} />
  {/if}
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
    display: grid;
    gap: 32px;
    padding: 24px var(--gutter) 48px;
  }

  @media (min-width: 900px) {
    .layout {
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 48px;
      padding: 32px 32px 48px;
    }
  }

  .right {
    display: grid;
    gap: 24px;
    align-content: start;
    min-width: 0;
  }
</style>
