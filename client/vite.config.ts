import { fileURLToPath } from "node:url";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

const server = "http://localhost:3000";

export default defineConfig({
  plugins: [svelte()],
  resolve: {
    alias: {
      "@listening-room/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)),
    },
  },
  server: {
    host: true,
    proxy: {
      "/api": server,
      "/media": server,
      "/ws": { target: server, ws: true },
    },
  },
});
