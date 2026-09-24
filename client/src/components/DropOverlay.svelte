<script lang="ts">
  let { visible }: { visible: boolean } = $props();
</script>

{#if visible}
  <div class="overlay" aria-hidden="true">
    <div class="target">
      <p>Drop to add to the queue</p>
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 45;
    display: grid;
    place-items: center;
    padding: 24px;
    background: var(--overlay);
    pointer-events: none;
    animation: fade 120ms ease-out;
  }

  .target {
    display: grid;
    place-items: center;
    width: 100%;
    height: 100%;
    border: 3px dashed var(--accent);
    border-radius: var(--radius-l);
  }

  p {
    padding: 16px 28px;
    border-radius: 999px;
    background: var(--surface);
    font-family: var(--font-display);
    font-size: 26px;
    font-weight: 560;
  }

  @keyframes fade {
    from {
      opacity: 0;
    }
  }
</style>
