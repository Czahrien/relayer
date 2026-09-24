<script lang="ts" module>
  // Hand-drawn 24px icons: filled shapes for transport, 1.75 strokes elsewhere.
  const icons = {
    play: { fill: "M8 5.5v13a1 1 0 0 0 1.52.85l10.4-6.5a1 1 0 0 0 0-1.7L9.52 4.65A1 1 0 0 0 8 5.5Z" },
    pause: { fill: "M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" },
    previous: { fill: "M6 5h2.25v14H6zM19 5.9v12.2a.9.9 0 0 1-1.38.76L9.5 13.2a1.4 1.4 0 0 1 0-2.4l8.12-5.66A.9.9 0 0 1 19 5.9Z" },
    next: { fill: "M15.75 5H18v14h-2.25zM5 5.9v12.2a.9.9 0 0 0 1.38.76l8.12-5.66a1.4 1.4 0 0 0 0-2.4L6.38 5.14A.9.9 0 0 0 5 5.9Z" },
    restart: { stroke: "M4 12a8 8 0 1 0 2.35-5.65M4 4v4.5h4.5" },
    volume: { stroke: "M4 9.5h3l4.5-4v13l-4.5-4H4zM15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" },
    mute: { stroke: "M4 9.5h3l4.5-4v13l-4.5-4H4zM16 9.5l5 5M21 9.5l-5 5" },
    link: { stroke: "M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" },
    check: { stroke: "M5 12.5l4.5 4.5L19 7.5" },
    more: { fill: "M5 10.25a1.75 1.75 0 1 1 0 3.5 1.75 1.75 0 0 1 0-3.5Zm7 0a1.75 1.75 0 1 1 0 3.5 1.75 1.75 0 0 1 0-3.5Zm7 0a1.75 1.75 0 1 1 0 3.5 1.75 1.75 0 0 1 0-3.5Z" },
    plus: { stroke: "M12 5v14M5 12h14" },
    file: { stroke: "M9 18V6l10-2v12M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm10-2a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" },
    folder: { stroke: "M3.5 7a1.5 1.5 0 0 1 1.5-1.5h4l2 2.5h8a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z" },
    youtube: { fill: "M21.6 7.2a2.5 2.5 0 0 0-1.77-1.77C18.27 5 12 5 12 5s-6.27 0-7.83.43A2.5 2.5 0 0 0 2.4 7.2 26 26 0 0 0 2 12a26 26 0 0 0 .4 4.8 2.5 2.5 0 0 0 1.77 1.77C5.73 19 12 19 12 19s6.27 0 7.83-.43a2.5 2.5 0 0 0 1.77-1.77A26 26 0 0 0 22 12a26 26 0 0 0-.4-4.8ZM10 15V9l5.2 3Z" },
    close: { stroke: "M6 6l12 12M18 6L6 18" },
    grip: { fill: "M9 6.5a1.25 1.25 0 1 1 0 2.5 1.25 1.25 0 0 1 0-2.5Zm6 0a1.25 1.25 0 1 1 0 2.5 1.25 1.25 0 0 1 0-2.5Zm-6 4.25a1.25 1.25 0 1 1 0 2.5 1.25 1.25 0 0 1 0-2.5Zm6 0a1.25 1.25 0 1 1 0 2.5 1.25 1.25 0 0 1 0-2.5ZM9 15a1.25 1.25 0 1 1 0 2.5A1.25 1.25 0 0 1 9 15Zm6 0a1.25 1.25 0 1 1 0 2.5 1.25 1.25 0 0 1 0-2.5Z" },
    chevron: { stroke: "M6 9.5l6 6 6-6" },
    upload: { stroke: "M12 15.5V4.5M7.5 9L12 4.5 16.5 9M5 19.5h14" },
    trash: { stroke: "M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 12.5h9l1-12.5" },
    external: { stroke: "M14 4.5h5.5V10M19.5 4.5L11 13M17 13.5v4.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 5 18V9a1.5 1.5 0 0 1 1.5-1.5H11" },
    copy: { stroke: "M9 9V5.5A1.5 1.5 0 0 1 10.5 4h8A1.5 1.5 0 0 1 20 5.5v8a1.5 1.5 0 0 1-1.5 1.5H15M5.5 9h8A1.5 1.5 0 0 1 15 10.5v8a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 4 18.5v-8A1.5 1.5 0 0 1 5.5 9Z" },
    bell: { stroke: "M6 16.5V11a6 6 0 1 1 12 0v5.5l1.5 2h-15ZM10 20.5a2.2 2.2 0 0 0 4 0" },
    search: { stroke: "M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13ZM15.3 15.3 20 20" },
    library: { stroke: "M5 4.5v15M9.5 4.5v15M14 5.3l4.7 14" },
    back: { stroke: "M14.5 6l-6 6 6 6" },
    queueNext: { stroke: "M4 6h11M4 11h11M4 16h6M15 14l4 3-4 3z" },
  } as const;

  export type IconName = keyof typeof icons;
</script>

<script lang="ts">
  let { name, size = 22 }: { name: IconName; size?: number } = $props();
  const icon = $derived(icons[name] as { fill?: string; stroke?: string });
</script>

<svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
  {#if icon.fill}
    <path d={icon.fill} fill="currentColor" />
  {:else}
    <path
      d={icon.stroke}
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  {/if}
</svg>

<style>
  svg {
    display: block;
    flex: none;
  }
</style>
