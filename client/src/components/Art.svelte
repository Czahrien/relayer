<script lang="ts">
  import { hueFor, initialsFor } from "../lib/art.js";

  let { title, artUrl, size = "large" }: { title: string; artUrl?: string; size?: "large" | "small" } = $props();
  let failed = $state(false);
  const hue = $derived(hueFor(title));

  $effect(() => {
    void artUrl;
    failed = false;
  });
</script>

{#if artUrl && !failed}
  <img class="art {size}" src={artUrl} alt="" loading="lazy" onerror={() => (failed = true)} />
{:else}
  <div class="art placeholder {size}" style:--hue={hue} aria-hidden="true">
    <span>{initialsFor(title)}</span>
  </div>
{/if}

<style>
  .art {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  /* Generated cover: two tones of one hue with a large set monogram. */
  .placeholder {
    display: grid;
    place-items: center;
    background:
      radial-gradient(120% 90% at 20% 10%, hsl(var(--hue) 55% 62% / 0.9), transparent 60%),
      linear-gradient(155deg, hsl(var(--hue) 42% 44%), hsl(calc(var(--hue) + 35) 48% 22%));
    color: hsl(var(--hue) 60% 94%);
    font-family: var(--font-display);
    font-weight: 600;
    letter-spacing: -0.03em;
    overflow: hidden;
    user-select: none;
  }

  .placeholder.large span {
    font-size: clamp(64px, 14vw, 140px);
  }

  .placeholder.small span {
    font-size: 16px;
  }
</style>
