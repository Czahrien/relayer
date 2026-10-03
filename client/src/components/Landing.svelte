<script lang="ts">
  import SiteFooter from "./SiteFooter.svelte";
  // A plain form POST rather than fetch: the server answers with a redirect to
  // the new room, and an auth portal in front of /start can redirect to login.
  let starting = $state(false);
</script>

<svelte:window onpageshow={() => (starting = false)} />

<main>
  <div class="record" aria-hidden="true">
    <!-- Printed off-centre like a real label, so the spin shows. -->
    <svg class="label" viewBox="0 0 100 100">
      <path id="label-arc" d="M 15 50 A 35 35 0 0 1 85 50" fill="none" />
      <!-- Runs left to right under the hole, so its letters stand upright inside the arc. -->
      <path id="label-arc-low" d="M 13 50 A 37 37 0 0 0 87 50" fill="none" />
      <circle class="rule" cx="50" cy="50" r="48" />
      <circle class="rule" cx="50" cy="50" r="11" />
      <text><textPath href="#label-arc" startOffset="50%" text-anchor="middle">RELAYER</textPath></text>
      <text class="fine">
        <textPath href="#label-arc-low" startOffset="50%" text-anchor="middle">SIDE A · 33⅓ RPM</textPath>
      </text>
    </svg>
  </div>
  <h1>Relayer</h1>
  <p class="lede">
    Start a session and share the link. Everyone who opens it hears the same thing at the same moment. Drop in
    audio files, whole album folders, or YouTube links.
  </p>
  <form method="post" action="/start" onsubmit={() => (starting = true)}>
    <button class="btn primary" type="submit" disabled={starting}>
      {starting ? "Starting…" : "Start a session"}
    </button>
  </form>
</main>
<SiteFooter />

<style>
  main {
    display: grid;
    justify-items: center;
    align-content: center;
    gap: 20px;
    min-height: calc(100dvh - 60px);
    padding: 48px var(--gutter);
    text-align: center;
  }

  .record {
    display: grid;
    place-items: center;
    width: 132px;
    aspect-ratio: 1;
    margin-bottom: 12px;
    border-radius: 50%;
    background: repeating-radial-gradient(circle, #1c1a17 0 2px, #26231f 2px 4px);
    box-shadow: var(--art-shadow);
    animation: spin 6s linear infinite;
  }

  .label {
    width: 40%;
    aspect-ratio: 1;
    border-radius: 50%;
    background:
      radial-gradient(circle, var(--bg) 0 6%, transparent 7%),
      /* Bands step toward --ink: darker in light mode, lighter in dark mode. */
      linear-gradient(
        var(--accent) 0 56%,
        color-mix(in oklab, var(--accent), var(--ink) 8%) 56% 64%,
        color-mix(in oklab, var(--accent), var(--ink) 16%) 64% 72%,
        color-mix(in oklab, var(--accent), var(--ink) 24%) 72% 80%,
        color-mix(in oklab, var(--accent), var(--ink) 32%) 80%
      );
  }

  /* In viewBox units: the label is 100 across, so 15 is about 8px. */
  .label text {
    fill: var(--accent-ink);
    font-family: var(--font-display);
    font-size: 15px;
    font-weight: 600;
    letter-spacing: 0.1em;
  }

  .label .fine {
    font-family: var(--font-ui);
    font-size: 8px;
    font-weight: 600;
    letter-spacing: 0.06em;
    opacity: 0.75;
  }

  .rule {
    fill: none;
    stroke: var(--accent-ink);
    stroke-width: 0.8;
    opacity: 0.35;
  }

  h1 {
    font-family: var(--font-display);
    font-size: clamp(36px, 7vw, 56px);
    font-weight: 560;
    letter-spacing: -0.02em;
    line-height: 1.05;
  }

  .lede {
    max-width: 30em;
    color: var(--ink-2);
    font-size: 17px;
    text-wrap: pretty;
  }

  .btn {
    margin-top: 8px;
    min-width: 200px;
  }

  @media (prefers-reduced-motion: reduce) {
    .record {
      animation: none;
    }
  }

  @keyframes spin {
    to {
      rotate: 1turn;
    }
  }
</style>
