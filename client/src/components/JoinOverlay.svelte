<script lang="ts">
  import { MAX_NAME_LENGTH } from "@relayer/shared";
  import { prefs } from "../lib/storage.js";

  let { roomId, onjoin }: { roomId: string; onjoin: (name: string) => void } = $props();
  let name = $state(prefs.name);

  function submit(event: SubmitEvent) {
    event.preventDefault();
    const trimmed = name.trim().slice(0, MAX_NAME_LENGTH);
    if (!trimmed) return;
    prefs.name = trimmed;
    // This click is the user gesture that unlocks audio; onjoin must stay synchronous.
    onjoin(trimmed);
  }
</script>

<div class="scrim">
  <form class="card" onsubmit={submit} aria-labelledby="join-title">
    <p class="eyebrow">Room {roomId}</p>
    <h1 id="join-title">Pull up a chair</h1>
    <label for="join-name">Your name, so others know who's listening</label>
    <!-- svelte-ignore a11y_autofocus -->
    <input
      id="join-name"
      class="field"
      bind:value={name}
      maxlength={MAX_NAME_LENGTH}
      autocomplete="nickname"
      autofocus
      required
    />
    <button class="btn primary" type="submit" disabled={!name.trim()}>Join and listen</button>
  </form>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 40;
    display: grid;
    place-items: center;
    padding: var(--gutter);
    background: var(--bg);
  }

  .card {
    display: grid;
    gap: 12px;
    width: min(400px, 100%);
    padding: 28px;
    border: 1px solid var(--line);
    border-radius: var(--radius-l);
    background: var(--surface);
    box-shadow: var(--shadow);
  }

  .eyebrow {
    color: var(--ink-3);
    font-size: 13px;
    font-variant-numeric: tabular-nums;
  }

  h1 {
    margin-bottom: 8px;
    font-family: var(--font-display);
    font-size: 30px;
    font-weight: 560;
    letter-spacing: -0.015em;
  }

  label {
    color: var(--ink-2);
    font-size: 14px;
  }

  .btn {
    margin-top: 8px;
  }
</style>
