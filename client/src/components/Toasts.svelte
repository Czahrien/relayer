<script lang="ts">
  import { dismissToast, toasts } from "../lib/toasts.svelte.js";
  import Icon from "./Icon.svelte";
</script>

<div class="toasts" role="status" aria-live="polite">
  {#each toasts as t (t.id)}
    <div class="toast" class:error={t.tone === "error"}>
      <span>{t.message}</span>
      <button class="icon-btn" type="button" aria-label="Dismiss" onclick={() => dismissToast(t.id)}>
        <Icon name="close" size={18} />
      </button>
    </div>
  {/each}
</div>

<style>
  .toasts {
    position: fixed;
    z-index: 50;
    left: 50%;
    bottom: calc(16px + env(safe-area-inset-bottom));
    translate: -50% 0;
    display: grid;
    gap: 8px;
    width: min(440px, calc(100vw - 32px));
    pointer-events: none;
  }

  .toast {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 4px 4px 16px;
    border-radius: var(--radius);
    background: var(--ink);
    color: var(--bg);
    box-shadow: var(--shadow);
    pointer-events: auto;
    animation: rise 180ms ease-out;
  }

  .toast span {
    flex: 1;
    padding: 8px 0;
  }

  .toast.error {
    border-left: 4px solid var(--bad);
  }

  .toast .icon-btn {
    color: inherit;
    opacity: 0.75;
  }

  .toast .icon-btn:hover {
    background: transparent;
    color: inherit;
    opacity: 1;
  }

  @keyframes rise {
    from {
      opacity: 0;
      translate: 0 8px;
    }
  }
</style>
