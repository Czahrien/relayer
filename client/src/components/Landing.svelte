<script lang="ts">
  import { toast } from "../lib/toasts.svelte.js";

  let { navigate }: { navigate: (path: string) => void } = $props();
  let starting = $state(false);

  async function start() {
    starting = true;
    try {
      const response = await fetch("/api/rooms", { method: "POST" });
      if (!response.ok) throw new Error(String(response.status));
      const { roomId } = (await response.json()) as { roomId: string };
      navigate(`/r/${roomId}`);
    } catch {
      toast("Couldn't start a session. Is the server running?", "error");
      starting = false;
    }
  }
</script>

<main>
  <div class="record" aria-hidden="true">
    <div class="label"></div>
  </div>
  <h1>Listening Room</h1>
  <p class="lede">
    Start a session and share the link. Everyone who opens it hears the same thing at the same moment. Drop in
    audio files, whole album folders, or YouTube links.
  </p>
  <button class="btn primary" type="button" onclick={start} disabled={starting}>
    {starting ? "Starting…" : "Start a session"}
  </button>
</main>

<style>
  main {
    display: grid;
    justify-items: center;
    align-content: center;
    gap: 20px;
    min-height: 100dvh;
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
    background: radial-gradient(circle, var(--bg) 0 6%, var(--accent) 7%);
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

  @keyframes spin {
    to {
      rotate: 1turn;
    }
  }
</style>
