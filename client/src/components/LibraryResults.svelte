<script lang="ts">
  import { formatTime, type AddPosition, type LibraryAlbumInfo, type LibrarySearchResult, type LibraryTrackInfo } from "@relayer/shared";
  import type { AlbumDetail, ArtistDetail } from "../lib/library.js";
  import type { RoomClient } from "../lib/room.svelte.js";
  import { toast } from "../lib/toasts.svelte.js";
  import Art from "./Art.svelte";
  import Icon from "./Icon.svelte";

  let { client, results }: { client: RoomClient; results: LibrarySearchResult } = $props();

  const SONGS_SHOWN = 8;
  const ALBUMS_SHOWN = 6;

  /** An artist opened from the results; null shows the search results. */
  let artist = $state<ArtistDetail | null>(null);
  let expanded = $state<Record<string, AlbumDetail | "loading">>({});
  let showAllSongs = $state(false);
  let showAllAlbums = $state(false);

  // A new search closes any open artist and albums and resets the lists.
  $effect(() => {
    void results;
    artist = null;
    expanded = {};
    showAllSongs = false;
    showAllAlbums = false;
  });

  const songs = $derived(artist ? artist.tracks : results.tracks);
  const albums = $derived(artist ? artist.albums : results.albums);
  const visibleSongs = $derived(showAllSongs ? songs : songs.slice(0, SONGS_SHOWN));
  const visibleAlbums = $derived(showAllAlbums ? albums : albums.slice(0, ALBUMS_SHOWN));
  const empty = $derived(!artist && results.artists.length === 0 && albums.length === 0 && songs.length === 0);

  const artUrl = (albumId: string | undefined, hasArt: boolean) =>
    albumId && hasArt ? client.library.albumArtUrl(albumId) : undefined;

  function addTrack(track: LibraryTrackInfo, position: AddPosition) {
    client.addLibrary([track.id], position, `“${track.title}”`);
  }

  async function albumDetail(album: LibraryAlbumInfo): Promise<AlbumDetail | null> {
    const cached = expanded[album.id];
    if (cached && cached !== "loading") return cached;
    try {
      return await client.library.album(album.id);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Couldn't load that album.", "error");
      return null;
    }
  }

  async function addAlbum(album: LibraryAlbumInfo, position: AddPosition) {
    const detail = await albumDetail(album);
    if (!detail) return;
    client.addLibrary(
      detail.tracks.map((t) => t.id),
      position,
      `${detail.tracks.length} ${detail.tracks.length === 1 ? "track" : "tracks"} from “${album.title}”`,
    );
  }

  async function toggleAlbum(album: LibraryAlbumInfo) {
    if (expanded[album.id]) {
      const { [album.id]: _, ...rest } = expanded;
      expanded = rest;
      return;
    }
    expanded = { ...expanded, [album.id]: "loading" };
    const detail = await albumDetail(album);
    if (detail) expanded = { ...expanded, [album.id]: detail };
    else {
      const { [album.id]: _, ...rest } = expanded;
      expanded = rest;
    }
  }

  async function openArtist(name: string) {
    try {
      artist = await client.library.artist(name);
      expanded = {};
      showAllSongs = false;
      showAllAlbums = false;
    } catch (err) {
      toast(err instanceof Error ? err.message : "Couldn't load that artist.", "error");
    }
  }
</script>

{#snippet actions(label: string, add: () => void, next: () => void)}
  <div class="actions">
    <button class="icon-btn" type="button" aria-label="Play {label} next" title="Play next" onclick={next}>
      <Icon name="queueNext" size={19} />
    </button>
    <button class="icon-btn add" type="button" aria-label="Add {label} to the queue" title="Add to queue" onclick={add}>
      <Icon name="plus" size={20} />
    </button>
  </div>
{/snippet}

{#snippet trackRow(track: LibraryTrackInfo, showArt: boolean)}
  <li class="row">
    {#if showArt}
      <span class="thumb"><Art title={track.album ?? track.title} artUrl={artUrl(track.albumId, track.hasArt)} size="small" /></span>
    {:else}
      <span class="number">{track.trackNo ?? ""}</span>
    {/if}
    <span class="text">
      <span class="title">{track.title}</span>
      {#if showArt}
        <span class="meta">{[track.artist, track.album].filter(Boolean).join(" · ")}</span>
      {/if}
    </span>
    <span class="duration">{formatTime(track.durationMs)}</span>
    {@render actions(`“${track.title}”`, () => addTrack(track, "end"), () => addTrack(track, "next"))}
  </li>
{/snippet}

<div class="results" aria-live="polite">
  {#if artist}
    <div class="artist-head">
      <button class="icon-btn" type="button" aria-label="Back to search results" onclick={() => (artist = null)}>
        <Icon name="back" size={20} />
      </button>
      <div>
        <h3>{artist.artist.name}</h3>
        <p class="meta">
          {artist.albums.length}
          {artist.albums.length === 1 ? "album" : "albums"} · {artist.tracks.length}
          {artist.tracks.length === 1 ? "song" : "songs"}
        </p>
      </div>
    </div>
  {:else if empty}
    <p class="empty">Nothing in the library matches.</p>
  {:else if results.artists.length > 0}
    <section>
      <h3>Artists</h3>
      <ul class="artists">
        {#each results.artists as a (a.name)}
          <li>
            <button class="chip" type="button" onclick={() => openArtist(a.name)}>
              <span>{a.name}</span>
              <span class="count">{a.trackCount}</span>
            </button>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if albums.length > 0}
    <section>
      <h3>Albums</h3>
      <ul>
        {#each visibleAlbums as album (album.id)}
          {@const open = expanded[album.id]}
          <li class="album">
            <div class="row">
              <button
                class="expand"
                type="button"
                aria-expanded={!!open}
                aria-label="{open ? 'Hide' : 'Show'} tracks of “{album.title}”"
                onclick={() => toggleAlbum(album)}
              >
                <span class="thumb"><Art title={album.title} artUrl={artUrl(album.id, album.hasArt)} size="small" /></span>
                <span class="text">
                  <span class="title">{album.title}</span>
                  <span class="meta">
                    {[album.artist, album.year, `${album.trackCount} ${album.trackCount === 1 ? "track" : "tracks"}`]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
                <span class="chevron" class:open={!!open}><Icon name="chevron" size={18} /></span>
              </button>
              {@render actions(`the album “${album.title}”`, () => addAlbum(album, "end"), () => addAlbum(album, "next"))}
            </div>
            {#if open === "loading"}
              <p class="loading">Loading tracks…</p>
            {:else if open}
              <ul class="tracks">
                {#each open.tracks as track (track.id)}
                  {@render trackRow(track, false)}
                {/each}
              </ul>
            {/if}
          </li>
        {/each}
      </ul>
      {#if albums.length > ALBUMS_SHOWN}
        <button class="more" type="button" onclick={() => (showAllAlbums = !showAllAlbums)}>
          {showAllAlbums ? "Show fewer albums" : `Show all ${albums.length} albums`}
        </button>
      {/if}
    </section>
  {/if}

  {#if songs.length > 0}
    <section>
      <h3>Songs</h3>
      <ul>
        {#each visibleSongs as track (track.id)}
          {@render trackRow(track, true)}
        {/each}
      </ul>
      {#if songs.length > SONGS_SHOWN}
        <button class="more" type="button" onclick={() => (showAllSongs = !showAllSongs)}>
          {showAllSongs ? "Show fewer songs" : `Show all ${songs.length} songs`}
        </button>
      {/if}
    </section>
  {/if}
</div>

<style>
  .results {
    display: grid;
    gap: 16px;
    max-height: min(60vh, 560px);
    overflow-y: auto;
    padding: 12px;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--surface);
    overscroll-behavior: contain;
  }

  section {
    display: grid;
    gap: 4px;
  }

  h3 {
    color: var(--ink-3);
    font-size: 13px;
    font-weight: 600;
  }

  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .empty,
  .loading {
    color: var(--ink-3);
    font-size: 14px;
  }

  .loading {
    padding: 4px 0 8px 56px;
  }

  .artists {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-height: 36px;
    padding: 0 12px;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: var(--bg);
    font-size: 14px;
    font-weight: 560;
  }

  .chip:hover {
    background: var(--surface-2);
  }

  .count {
    color: var(--ink-3);
    font-weight: 400;
    font-variant-numeric: tabular-nums;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 52px;
    border-radius: var(--radius-s);
  }

  .row:hover {
    background: var(--surface-2);
  }

  .expand {
    display: flex;
    flex: 1;
    align-items: center;
    gap: 10px;
    min-width: 0;
    min-height: 52px;
    padding: 0;
    border: 0;
    border-radius: var(--radius-s);
    background: none;
    text-align: left;
  }

  .thumb {
    flex: none;
    width: 40px;
    height: 40px;
    margin-left: 4px;
    border-radius: 5px;
    overflow: hidden;
    background: var(--surface-2);
  }

  .number {
    flex: none;
    width: 40px;
    margin-left: 4px;
    color: var(--ink-3);
    font-size: 13px;
    font-variant-numeric: tabular-nums;
    text-align: center;
  }

  .text {
    display: grid;
    flex: 1;
    min-width: 0;
  }

  .title,
  .meta {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .title {
    font-weight: 560;
  }

  .meta {
    color: var(--ink-3);
    font-size: 13px;
  }

  .duration {
    flex: none;
    color: var(--ink-3);
    font-size: 13px;
    font-variant-numeric: tabular-nums;
  }

  .chevron {
    flex: none;
    color: var(--ink-3);
    rotate: -90deg;
    transition: rotate 150ms;
  }

  .chevron.open {
    rotate: 0deg;
  }

  .actions {
    display: flex;
    flex: none;
  }

  .actions .icon-btn {
    width: 40px;
    height: 40px;
  }

  .actions .add {
    color: var(--accent);
  }

  .tracks {
    margin: 0 0 6px;
    padding-left: 12px;
    border-left: 2px solid var(--line);
  }

  .more {
    justify-self: start;
    min-height: 36px;
    padding: 0 4px;
    border: 0;
    background: none;
    color: var(--accent);
    font-size: 14px;
    font-weight: 560;
  }

  .artist-head {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .artist-head h3 {
    color: var(--ink);
    font-family: var(--font-display);
    font-size: 20px;
    font-weight: 560;
  }
</style>
