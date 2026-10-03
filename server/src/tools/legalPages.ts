// Writes the privacy policy and terms of service as standalone HTML files, for
// hosting somewhere other than the server itself (e.g. GitHub Pages, when
// Discord won't accept a link to the server's domain).
//
//   npm run legal-pages -- https://relayer.example.com --out site
//   node server/dist/tools/legalPages.js https://relayer.example.com --out site   (e.g. in Docker)
//
// The pages are written from the same environment variables as the server
// (OPERATOR_CONTACT, ROOM_IDLE_TTL_MIN, YOUTUBE_API_KEY, DISCORD_*), so run it
// with the server's configuration. It writes privacy.html and terms.html.

import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { legalPages } from "../legal.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string", short: "o" },
    help: { type: "boolean", short: "h" },
  },
});

const usage = "Usage: legal-pages <server-url> --out <dir>\nWrites privacy.html and terms.html for the server at <server-url>.";
if (values.help) {
  console.log(usage);
  process.exit(0);
}
const serverUrl = positionals[0];
if (!serverUrl || !/^https?:\/\//.test(serverUrl) || !values.out) {
  console.error(usage);
  process.exit(2);
}

// `npm run` changes directory; resolve paths against where the command was typed.
const outDir = path.resolve(process.env.INIT_CWD ?? process.cwd(), values.out);
const { privacy, terms } = legalPages(loadConfig(), serverUrl);
await fs.mkdir(outDir, { recursive: true });
await fs.writeFile(path.join(outDir, "privacy.html"), privacy);
await fs.writeFile(path.join(outDir, "terms.html"), terms);
console.error(`Wrote privacy.html and terms.html to ${outDir}`);
