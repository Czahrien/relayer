<script lang="ts"></script>

<main>
  <div class="card">
    <h1>This room doesn't exist</h1>
    <p>It may have ended. Rooms close after everyone has been gone for a while, and when the server restarts.</p>
    <a class="btn primary" href="/start">Start a new session</a>
  </div>
</main>

<style>
  main {
    display: grid;
    place-items: center;
    min-height: 100dvh;
    padding: var(--gutter);
  }

  .card {
    display: grid;
    gap: 12px;
    width: min(420px, 100%);
    padding: 28px;
    border: 1px solid var(--line);
    border-radius: var(--radius-l);
    background: var(--surface);
    box-shadow: var(--shadow);
  }

  h1 {
    font-family: var(--font-display);
    font-size: 28px;
    font-weight: 560;
    letter-spacing: -0.015em;
  }

  p {
    color: var(--ink-2);
  }

  .btn {
    margin-top: 8px;
    text-decoration: none;
  }
</style>
