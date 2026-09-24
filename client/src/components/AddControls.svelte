<script lang="ts">
  import { collectFromFileList, extractLinks } from "../lib/ingest/drop.js";
  import type { RoomClient } from "../lib/room.svelte.js";
  import Icon from "./Icon.svelte";

  let { client }: { client: RoomClient } = $props();
  let link = $state("");
  let fileInput: HTMLInputElement | undefined = $state();
  let folderInput: HTMLInputElement | undefined = $state();

  // iOS has no folder picker; `webkitdirectory` is ignored there.
  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const folderSupported = !isIOS && "webkitdirectory" in document.createElement("input");

  function submitLink(event: SubmitEvent) {
    event.preventDefault();
    const text = link.trim();
    if (!text) return;
    const links = extractLinks("", text);
    void client.ingest({ files: [], links: links.length > 0 ? links : [text], skipped: 0 });
    link = "";
  }

  function picked(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    if (input.files && input.files.length > 0) void client.ingest(collectFromFileList(input.files));
    input.value = "";
  }
</script>

<div class="add">
  <form class="link" onsubmit={submitLink}>
    <label class="visually-hidden" for="add-link">YouTube link</label>
    <input
      id="add-link"
      class="field"
      type="text"
      inputmode="url"
      autocapitalize="off"
      spellcheck="false"
      placeholder="Paste a YouTube link"
      autocomplete="off"
      bind:value={link}
    />
    <button class="btn" type="submit" disabled={!link.trim()}>Add link</button>
  </form>
  <div class="pickers">
    <button class="btn small" type="button" onclick={() => fileInput?.click()}>
      <Icon name="file" size={18} /> Add files
    </button>
    {#if folderSupported}
      <button class="btn small" type="button" onclick={() => folderInput?.click()}>
        <Icon name="folder" size={18} /> Add a folder
      </button>
    {/if}
    <span class="hint">or drop them anywhere</span>
  </div>
  <input
    bind:this={fileInput}
    class="visually-hidden"
    type="file"
    multiple
    accept="audio/*,.mp3,.m4a,.aac,.flac,.ogg,.oga,.opus,.wav,.webm"
    tabindex="-1"
    onchange={picked}
  />
  {#if folderSupported}
    <input bind:this={folderInput} class="visually-hidden" type="file" webkitdirectory tabindex="-1" onchange={picked} />
  {/if}
</div>

<style>
  .add {
    display: grid;
    gap: 10px;
  }

  .link {
    display: flex;
    gap: 8px;
  }

  .link .field {
    flex: 1;
    min-width: 0;
  }

  .pickers {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }

  .hint {
    color: var(--ink-3);
    font-size: 13px;
  }
</style>
