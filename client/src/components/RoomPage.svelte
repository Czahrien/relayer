<script lang="ts">
  import { onDestroy } from "svelte";
  import { formatTime } from "@listening-room/shared";
  import { collectFromDataTransfer, collectFromFileList, extractLinks } from "../lib/ingest/drop.js";
  import { RoomClient } from "../lib/room.svelte.js";
  import { getClientId } from "../lib/storage.js";
  import AddControls from "./AddControls.svelte";
  import DebugPanel from "./DebugPanel.svelte";
  import DropOverlay from "./DropOverlay.svelte";
  import Header from "./Header.svelte";
  import JoinOverlay from "./JoinOverlay.svelte";
  import NowPlaying from "./NowPlaying.svelte";

  let { roomId }: { roomId: string } = $props();
  let client: RoomClient | null = $state(null);
  let dragDepth = $state(0);
  let showDebug = $state(false);

  function join(name: string) {
    const c = new RoomClient(roomId, getClientId(), name);
    c.unlockAudio(); // still inside the Join click
    c.start();
    client = c;
  }

  onDestroy(() => client?.destroy());

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

  function onKeyDown(event: KeyboardEvent) {
    if (!client || isEditable(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "d" || event.key === "D") showDebug = !showDebug;
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
    <main class="layout">
      <div class="left">
        <NowPlaying {client} />
      </div>
      <div class="right">
        <AddControls {client} />
        <ol class="queue">
          {#each client.snapshot?.items ?? [] as item, i (item.id)}
            <li class:current={i === client.snapshot?.currentIndex} class:history={i < (client.snapshot?.currentIndex ?? 0)}>
              <button type="button" onclick={() => client?.send({ type: "jump", itemId: item.id })}>
                {item.title}
              </button>
              <span>
                {#if item.status === "uploading"}
                  {client.uploadProgress[item.id] !== undefined
                    ? `${Math.round(client.uploadProgress[item.id]! * 100)}%`
                    : "uploading…"}
                {:else if item.status === "error"}
                  {item.error}
                {:else}
                  {formatTime(item.durationMs)}
                {/if}
              </span>
            </li>
          {/each}
        </ol>
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

  .queue li.current {
    font-weight: 700;
  }

  .queue li.history {
    opacity: 0.6;
  }
</style>
