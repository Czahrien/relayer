/** A stable hue from a string, for generated placeholder art. */
export function hueFor(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 360;
}

/** One or two letters for a placeholder cover. */
export function initialsFor(title: string): string {
  const words = title
    .replace(/^\d+[\s.\-_]*/, "")
    .split(/\s+/)
    .filter((w) => /\p{L}|\p{N}/u.test(w));
  const letters = words.slice(0, 2).map((w) => [...w.replace(/^[^\p{L}\p{N}]+/u, "")][0] ?? "");
  return letters.join("").toUpperCase() || "♪";
}
