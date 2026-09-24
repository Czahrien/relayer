<script lang="ts">
  import { parseYouTubeUrl, type LibrarySearchResult } from "@listening-room/shared";
  import { extractLinks } from "../lib/ingest/drop.js";
  import type { RoomClient } from "../lib/room.svelte.js";
  import Icon from "./Icon.svelte";
  import LibraryResults from "./LibraryResults.svelte";

  let { client }: { client: RoomClient } = $props();

  const DEBOUNCE_MS = 150;

  let text = $state("");
  let results = $state.raw<LibrarySearchResult | null>(null);
  let failed = $state(false);
  let input: HTMLInputElement | undefined = $state();

  const status = $derived(client.libraryStatus);
  const libraryOn = $derived(status?.enabled ?? false);
  const trimmed = $derived(text.trim());
  // Anything that looks like a link is a link; everything else is a search.
  const isLink = $derived(!!parseYouTubeUrl(trimmed) || /^(https?:\/\/|www\.)/i.test(trimmed));
  const searching = $derived(libraryOn && !isLink && trimmed.length > 0);

  // Search as you type, debounced; stale responses are dropped.
  $effect(() => {
    const q = trimmed;
    if (!searching) {
      results = null;
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      client.library.search(q, controller.signal).then(
        (r) => {
          results = r;
          failed = false;
        },
        (err: unknown) => {
          if ((err as Error).name !== "AbortError") failed = true;
        },
      );
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  });

  function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!isLink) return; // searches update as you type
    const links = extractLinks("", trimmed);
    void client.ingest({ files: [], links: links.length > 0 ? links : [trimmed], skipped: 0 });
    text = "";
  }

  function clear() {
    text = "";
    input?.focus();
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape" && text) {
      event.preventDefault();
      text = "";
    }
  }
</script>

<div class="search">
  <form role="search" onsubmit={submit}>
    <label class="visually-hidden" for="search-box">
      {libraryOn ? "Search the library, or paste a YouTube link" : "YouTube link"}
    </label>
    <div class="field-wrap">
      <span class="lead" aria-hidden="true"><Icon name={libraryOn ? "search" : "youtube"} size={18} /></span>
      <input
        bind:this={input}
        id="search-box"
        class="field"
        type="text"
        inputmode={libraryOn ? "search" : "url"}
        enterkeyhint={isLink ? "go" : "search"}
        placeholder={libraryOn ? "Search songs, albums, artists, or paste a YouTube link" : "Paste a YouTube link"}
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        bind:value={text}
        onkeydown={onKeyDown}
      />
      {#if text}
        <button class="icon-btn clear" type="button" aria-label="Clear" onclick={clear}>
          <Icon name="close" size={18} />
        </button>
      {/if}
    </div>
    {#if isLink || !libraryOn}
      <button class="btn" type="submit" disabled={!isLink}>Add video</button>
    {/if}
  </form>

  {#if status?.indexing}
    <p class="note">Indexing the library… {status.trackCount} tracks so far.</p>
  {/if}
  {#if searching && failed}
    <p class="note">The library search didn't respond. Try again in a moment.</p>
  {:else if searching && results}
    <LibraryResults {client} {results} />
  {/if}
</div>

<style>
  .search {
    display: grid;
    gap: 8px;
  }

  form {
    display: flex;
    gap: 8px;
  }

  .field-wrap {
    position: relative;
    flex: 1;
    min-width: 0;
  }

  .field {
    padding-left: 40px;
    padding-right: 44px;
  }

  .lead {
    position: absolute;
    left: 13px;
    top: 50%;
    translate: 0 -50%;
    color: var(--ink-3);
    pointer-events: none;
  }

  .clear {
    position: absolute;
    right: 0;
    top: 50%;
    translate: 0 -50%;
  }

  .note {
    color: var(--ink-3);
    font-size: 13px;
  }
</style>
