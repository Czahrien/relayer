<script lang="ts">
  import { isYouTubeLink, type LibrarySearchResult, type YouTubeResult } from "@relayer/shared";
  import { extractLinks } from "../lib/ingest/drop.js";
  import type { RoomClient } from "../lib/room.svelte.js";
  import Icon from "./Icon.svelte";
  import LibraryResults from "./LibraryResults.svelte";
  import YouTubeResults from "./YouTubeResults.svelte";

  let { client }: { client: RoomClient } = $props();

  const DEBOUNCE_MS = 150;

  let text = $state("");
  let results = $state.raw<LibrarySearchResult | null>(null);
  let failed = $state(false);
  let input: HTMLInputElement | undefined = $state();
  /** Which search the box runs when both are available. */
  let tab = $state<"library" | "youtube">("library");
  /** YouTube searches cost quota, so they run on Enter rather than as you type. */
  let ytResults = $state.raw<YouTubeResult[] | null>(null);
  let ytError = $state<string | null>(null);
  let ytBusy = $state(false);
  let ytController: AbortController | null = null;

  const status = $derived(client.libraryStatus);
  const libraryOn = $derived(status?.enabled ?? false);
  const youtubeOn = $derived(client.youtubeSearch);
  const mode = $derived<"library" | "youtube" | "links">(
    libraryOn && youtubeOn ? tab : libraryOn ? "library" : youtubeOn ? "youtube" : "links",
  );
  const trimmed = $derived(text.trim());
  // Anything that looks like a link is a link; everything else is a search.
  const isLink = $derived(isYouTubeLink(trimmed) || /^(https?:\/\/|www\.)/i.test(trimmed));
  const searching = $derived(mode === "library" && !isLink && trimmed.length > 0);
  const ytShown = $derived(mode === "youtube" && !isLink && trimmed.length > 0);

  const placeholder = $derived(
    mode === "library"
      ? "Search songs, albums, artists, or paste a YouTube link"
      : mode === "youtube"
        ? "Search YouTube, or paste a YouTube link"
        : "Paste a YouTube link",
  );

  // Clearing the box, or switching away, drops YouTube results.
  $effect(() => {
    if (!ytShown) {
      ytController?.abort();
      ytResults = null;
      ytError = null;
      ytBusy = false;
    }
  });

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
    if (!isLink) {
      // Library searches update as you type; YouTube searches wait for Enter.
      if (mode === "youtube" && trimmed) void searchYoutube(trimmed);
      return;
    }
    const links = extractLinks("", trimmed);
    void client.ingest({ files: [], links: links.length > 0 ? links : [trimmed], skipped: 0 });
    text = "";
  }

  async function searchYoutube(q: string) {
    ytController?.abort();
    const controller = new AbortController();
    ytController = controller;
    ytBusy = true;
    try {
      ytResults = await client.youtube.search(q, controller.signal);
      ytError = null;
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      ytResults = null;
      ytError = err instanceof Error ? err.message : "YouTube search didn't respond.";
    } finally {
      if (ytController === controller) ytBusy = false;
    }
  }

  function chooseTab(next: "library" | "youtube") {
    tab = next;
    input?.focus();
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
  {#if libraryOn && youtubeOn}
    <div class="tabs" role="group" aria-label="Search in">
      <button type="button" class="tab" aria-pressed={tab === "library"} onclick={() => chooseTab("library")}>
        Library
      </button>
      <button type="button" class="tab" aria-pressed={tab === "youtube"} onclick={() => chooseTab("youtube")}>
        YouTube
      </button>
    </div>
  {/if}
  <form role="search" onsubmit={submit}>
    <label class="visually-hidden" for="search-box">{placeholder}</label>
    <div class="field-wrap">
      <span class="lead" aria-hidden="true"><Icon name={mode === "library" ? "search" : "youtube"} size={18} /></span>
      <input
        bind:this={input}
        id="search-box"
        class="field"
        type="text"
        inputmode={mode === "links" ? "url" : "search"}
        enterkeyhint={isLink ? "go" : "search"}
        {placeholder}
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
    {#if mode === "youtube" && !isLink && trimmed}
      <button class="btn" type="submit" disabled={ytBusy}>Search</button>
    {:else if isLink || mode === "links"}
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
  {#if ytShown}
    {#if ytError}
      <p class="note">{ytError}</p>
    {:else if ytBusy && !ytResults}
      <p class="note">Searching YouTube…</p>
    {:else if ytResults}
      <YouTubeResults {client} results={ytResults} />
    {:else}
      <p class="note">Press Enter to search YouTube.</p>
    {/if}
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

  .tabs {
    display: flex;
    gap: 4px;
  }

  .tab {
    min-height: 32px;
    padding: 0 12px;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: none;
    color: var(--ink-2);
    font-size: 14px;
    font-weight: 560;
  }

  .tab:hover {
    background: var(--surface-2);
  }

  .tab[aria-pressed="true"] {
    border-color: var(--accent);
    background: var(--accent);
    color: var(--accent-ink);
  }

  .note {
    color: var(--ink-3);
    font-size: 13px;
  }
</style>
