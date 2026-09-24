// Writes a Markdown report of problems in a music library (SPEC §10.8).
//
//   npm run library-report -- [library-dir] [--out notes.md]
//   node server/dist/tools/libraryReport.js [library-dir] [--out notes.md]   (e.g. in Docker)
//
// The library directory defaults to LIBRARY_DIR. The report goes to --out, or
// to stdout; progress goes to stderr. It only reads the library, and it builds
// its own temporary index, so it's safe to run while the server is running.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { libraryReport } from "../library/report.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string", short: "o" },
    help: { type: "boolean", short: "h" },
  },
});

const usage = "Usage: library-report [library-dir] [--out notes.md]\nThe library directory defaults to LIBRARY_DIR.";
if (values.help) {
  console.log(usage);
  process.exit(0);
}

// `npm run` changes directory; resolve paths against where the command was typed.
const cwd = process.env.INIT_CWD ?? process.cwd();
const root = positionals[0] ?? process.env.LIBRARY_DIR;
if (!root) {
  console.error(`No library directory given, and LIBRARY_DIR isn't set.\n${usage}`);
  process.exit(2);
}
const libraryDir = path.resolve(cwd, root);
try {
  if (!(await fs.stat(libraryDir)).isDirectory()) throw new Error();
} catch {
  console.error(`Not a directory: ${libraryDir}`);
  process.exit(2);
}

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "library-report-"));
try {
  const report = await libraryReport(libraryDir, {
    dataDir,
    log: { info: (m) => console.error(m), warn: (m) => console.error(m) },
  });
  if (values.out) {
    const out = path.resolve(cwd, values.out);
    await fs.writeFile(out, report);
    console.error(`Wrote ${out}`);
  } else {
    process.stdout.write(report);
  }
} finally {
  await fs.rm(dataDir, { recursive: true, force: true });
}
