import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { Plugin } from "vite";

interface PackageNotice {
  name: string;
  version: string;
  license: string;
  text: string | null;
}

const NODE_MODULES = `${path.sep}node_modules${path.sep}`;
const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.(md|txt|markdown))?$/i;

/** The package directory a bundled module belongs to, or null for our own code. */
function packageRoot(id: string): string | null {
  const file = id.replace(/^\0/, "").split("?")[0]!;
  const at = file.lastIndexOf(NODE_MODULES);
  if (at < 0) return null;
  const parts = file.slice(at + NODE_MODULES.length).split(path.sep);
  const name = parts[0]!.startsWith("@") ? parts.slice(0, 2) : parts.slice(0, 1);
  return file.slice(0, at + NODE_MODULES.length) + name.join(path.sep);
}

function readNotice(root: string): PackageNotice | null {
  let pkg: { name?: string; version?: string; license?: string | { type?: string } };
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  } catch {
    return null;
  }
  const file = fs.readdirSync(root).find((f) => LICENSE_FILE.test(f));
  return {
    name: pkg.name ?? path.basename(root),
    version: pkg.version ?? "",
    license: typeof pkg.license === "string" ? pkg.license : (pkg.license?.type ?? "UNKNOWN"),
    text: file ? fs.readFileSync(path.join(root, file), "utf8").trim() : null,
  };
}

/**
 * Writes the licenses of every third-party package in the client build to
 * `third-party-licenses.txt`. Minified bundles and font files drop the
 * copyright notices that MIT, BSD, and OFL require be kept with copies.
 */
export function thirdPartyLicenses(fileName = "third-party-licenses.txt"): Plugin {
  const require = createRequire(import.meta.url);
  return {
    name: "third-party-licenses",
    apply: "build",
    generateBundle() {
      const roots = new Set<string>();
      for (const id of this.getModuleIds()) {
        const root = packageRoot(id);
        if (root) roots.add(root);
        // Vite's own runtime helpers are virtual modules.
        else if (id.startsWith("\0vite/")) roots.add(path.dirname(require.resolve("vite/package.json")));
      }
      const notices = [...roots]
        .map(readNotice)
        .filter((n): n is PackageNotice => n !== null)
        .sort((a, b) => a.name.localeCompare(b.name));
      const missing = notices.filter((n) => !n.text).map((n) => n.name);
      if (missing.length > 0) this.warn(`No license file found for: ${missing.join(", ")}`);

      const header =
        "Listening Room's web client includes the following third-party software.\n" +
        "Listening Room itself is released under the MIT License (see LICENSE).\n";
      const body = notices
        .map((n) => `${"=".repeat(72)}\n${n.name}@${n.version} (${n.license})\n${"=".repeat(72)}\n\n${n.text ?? `License: ${n.license}`}\n`)
        .join("\n");
      this.emitFile({ type: "asset", fileName, source: `${header}\n${body}` });
    },
  };
}
