import { fileURLToPath } from "node:url";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";
import { thirdPartyLicenses } from "./build/licenses.js";

const server = "http://localhost:3000";

export default defineConfig({
  plugins: [svelte(), thirdPartyLicenses()],
  resolve: {
    alias: {
      "@listening-room/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)),
    },
  },
  server: {
    host: true,
    proxy: {
      // The start page is served by Vite; only its form POST goes to the server.
      "/start": { target: server, bypass: (req) => (req.method === "POST" ? undefined : req.url) },
      "/api": server,
      "/media": server,
      "/ws": { target: server, ws: true },
    },
  },
});
