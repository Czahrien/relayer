<script lang="ts">
  import { tick } from "svelte";
  import { MAX_CHAT_LENGTH, type ActivityEntry } from "@relayer/shared";
  import { chatSegments } from "../lib/chatText.js";
  import type { RoomClient } from "../lib/room.svelte.js";
  import Icon from "./Icon.svelte";

  let { client }: { client: RoomClient } = $props();

  let open = $state(true);
  let draft = $state("");
  let list: HTMLOListElement | undefined = $state();
  /** Newest entry time seen while the panel was open, for the unread count. */
  let seenUpTo = $state(0);

  const entries = $derived(client.activity);
  const unread = $derived(
    open ? 0 : entries.filter((e) => e.kind === "message" && e.at > seenUpTo && e.by !== client.name).length,
  );

  let now = $state(0);
  $effect(() => {
    now = client.serverNow();
    const timer = setInterval(() => (now = client.serverNow()), 30_000);
    return () => clearInterval(timer);
  });

  // Keep up with new entries, unless someone scrolled up to read.
  let pinned = true;
  $effect(() => {
    const latest = entries.at(-1);
    if (!open || !latest) return;
    seenUpTo = latest.at;
    if (pinned) void tick().then(() => list?.scrollTo({ top: list.scrollHeight }));
  });

  function onScroll() {
    if (list) pinned = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  }

  async function toggle() {
    open = !open;
    if (open) {
      pinned = true;
      await tick();
      list?.scrollTo({ top: list.scrollHeight });
    }
  }

  function send(event: SubmitEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    if (client.send({ type: "chat", text })) {
      draft = "";
      pinned = true;
    }
  }

  function addVideo(url: string) {
    void client.ingest({ files: [], links: [url], skipped: 0 });
  }

  function ago(at: number): string {
    const s = Math.max(0, Math.round((now - at) / 1000));
    if (s < 60) return "just now";
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min ago`;
    return `${Math.round(m / 60)} h ago`;
  }

  const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const isMessage = (e: ActivityEntry) => e.kind === "message";
</script>

<section class="chat" aria-labelledby="chat-title">
  <button class="toggle" type="button" aria-expanded={open} onclick={toggle}>
    <h2 id="chat-title">Chat</h2>
    {#if unread > 0}
      <span class="badge">{unread} new</span>
    {/if}
    <span class="chevron" class:open aria-hidden="true"><Icon name="chevron" size={18} /></span>
  </button>

  {#if open}
    {#if entries.length === 0}
      <p class="empty">Say hello, or share something to listen to.</p>
    {:else}
      <ol bind:this={list} onscroll={onScroll} aria-live="polite" aria-label="Chat and room activity">
        {#each entries as entry, i (`${entry.at}-${i}`)}
          <li class:message={isMessage(entry)} class:event={!isMessage(entry)}>
            <p class="text">
              {#if entry.by}<b>{entry.by}</b>{" "}{/if}{#each chatSegments(entry.text) as segment, j (j)}{#if "url" in segment}<a
                    href={segment.url}
                    target="_blank"
                    rel="noopener noreferrer ugc">{segment.url}</a
                  >{#if segment.youtube}{" "}<button
                      class="add"
                      type="button"
                      onclick={() => addVideo(segment.url)}
                      aria-label="Add this video to the queue">
                      <Icon name="plus" size={14} /> Add to queue
                    </button>{/if}{:else}{segment.text}{/if}{/each}
            </p>
            <time datetime={new Date(entry.at).toISOString()} title={clock(entry.at)}>{ago(entry.at)}</time>
          </li>
        {/each}
      </ol>
    {/if}
    <form onsubmit={send}>
      <label class="visually-hidden" for="chat-input">Message the room</label>
      <input
        id="chat-input"
        class="field"
        type="text"
        placeholder="Message the room"
        autocomplete="off"
        enterkeyhint="send"
        maxlength={MAX_CHAT_LENGTH}
        bind:value={draft}
      />
      <button class="btn" type="submit" disabled={!draft.trim()}>Send</button>
    </form>
  {/if}
</section>

<style>
  .chat {
    display: grid;
    gap: 8px;
  }

  .toggle {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: var(--tap);
    padding: 0;
    border: 0;
    border-bottom: 1px solid var(--line);
    background: none;
    text-align: left;
  }

  h2 {
    flex: 1;
    font-family: var(--font-display);
    font-size: 18px;
    font-weight: 560;
  }

  .badge {
    padding: 2px 8px;
    border-radius: 999px;
    background: var(--accent);
    color: var(--accent-ink);
    font-size: 12px;
    font-weight: 600;
  }

  .chevron {
    color: var(--ink-3);
    rotate: -90deg;
    transition: rotate 150ms;
  }

  .chevron.open {
    rotate: 0deg;
  }

  ol {
    display: grid;
    gap: 2px;
    max-height: 320px;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    list-style: none;
  }

  li {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    padding: 4px 0;
  }

  .text {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .message .text {
    color: var(--ink);
    font-size: 15px;
  }

  .event .text {
    color: var(--ink-3);
    font-size: 13px;
  }

  .event b {
    color: var(--ink-2);
    font-weight: 600;
  }

  .message b {
    font-weight: 650;
  }

  a {
    color: var(--accent);
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .add {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-height: 28px;
    margin-left: 2px;
    padding: 0 10px;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: var(--surface);
    font-size: 13px;
    font-weight: 560;
    vertical-align: middle;
  }

  .add:hover {
    background: var(--surface-2);
  }

  time {
    flex: none;
    color: var(--ink-3);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }

  .empty {
    color: var(--ink-3);
    font-size: 14px;
  }

  form {
    display: flex;
    gap: 8px;
  }

  form .field {
    flex: 1;
    min-width: 0;
  }
</style>
