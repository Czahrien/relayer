<script lang="ts">
  import {
    notificationPermission,
    notificationSupport,
    requestNotificationPermission,
  } from "../lib/notifications.js";
  import type { RoomClient } from "../lib/room.svelte.js";
  import Icon from "./Icon.svelte";

  let { client }: { client: RoomClient } = $props();

  const support = notificationSupport();
  let open = $state(false);
  let permission = $state(notificationPermission());
  const active = $derived(permission === "granted" && (client.notifySongs || client.notifyChat));

  const options = [
    { kind: "songs", label: "When a song starts" },
    { kind: "chat", label: "When someone sends a message" },
  ] as const;

  const isOn = (kind: "songs" | "chat") => permission === "granted" && (kind === "songs" ? client.notifySongs : client.notifyChat);

  async function toggle(kind: "songs" | "chat") {
    const next = !isOn(kind);
    if (next) {
      permission = await requestNotificationPermission();
      if (permission !== "granted") return;
    }
    client.setNotify(kind, next);
  }

  function onWindowPointerDown(event: PointerEvent) {
    if (open && !(event.target as HTMLElement).closest(".notifications")) open = false;
  }
</script>

<svelte:window onpointerdown={onWindowPointerDown} onkeydown={(e) => e.key === "Escape" && (open = false)} />

<div class="notifications">
  <button
    class="icon-btn"
    class:active
    type="button"
    aria-label="Notifications"
    title="Notifications"
    aria-haspopup="true"
    aria-expanded={open}
    onclick={() => (open = !open)}
  >
    <Icon name="bell" size={20} />
  </button>
  {#if open}
    <div class="panel" role="group" aria-label="Notifications">
      <p class="heading">Notify me while I'm in another tab</p>
      {#if support === "supported" && permission !== "denied"}
        {#each options as option (option.kind)}
          <label>
            <input type="checkbox" checked={isOn(option.kind)} onchange={(e) => { e.currentTarget.checked = isOn(option.kind); void toggle(option.kind); }} />
            {option.label}
          </label>
        {/each}
      {:else if support === "needs-https"}
        <p class="note">Notifications need a secure connection. They'll work once Relayer is served over HTTPS.</p>
      {:else if support === "unsupported"}
        <p class="note">This browser can't show notifications for web pages. On iPhone, the lock screen still shows what's playing.</p>
      {:else}
        <p class="note">Notifications are blocked for this site. You can allow them in your browser's site settings.</p>
      {/if}
    </div>
  {/if}
</div>

<style>
  .notifications {
    position: relative;
  }

  .active {
    color: var(--accent);
  }

  .panel {
    position: absolute;
    z-index: 20;
    left: 0;
    top: calc(100% + 6px);
    display: grid;
    gap: 4px;
    width: 280px;
    padding: 12px;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--surface);
    box-shadow: var(--shadow);
  }

  .heading {
    color: var(--ink-3);
    font-size: 13px;
    font-weight: 600;
  }

  label {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 40px;
    font-size: 14px;
    cursor: pointer;
  }

  input {
    width: 18px;
    height: 18px;
    margin: 0;
    accent-color: var(--accent);
  }

  .note {
    color: var(--ink-2);
    font-size: 14px;
  }
</style>
