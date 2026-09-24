/** Case- and accent-insensitive form of a string: "Beyoncé" → "beyonce". */
export function normalize(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

/** Normalized words, split on anything that isn't a letter or number. */
export function words(text: string): string[] {
  return normalize(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

export interface SearchField {
  text: string;
  /** How much a match in this field counts, e.g. titles over albums. */
  weight: number;
}

/** A prepared field: normalized once, matched many times. */
export interface IndexedField {
  full: string;
  words: string[];
  weight: number;
}

export function indexFields(fields: SearchField[]): IndexedField[] {
  return fields
    .filter((f) => f.text)
    .map((f) => ({ full: normalize(f.text).trim(), words: words(f.text), weight: f.weight }));
}

export interface Query {
  full: string;
  words: string[];
}

export function parseQuery(text: string): Query | null {
  const q = { full: normalize(text).trim(), words: words(text) };
  return q.words.length > 0 ? q : null;
}

/**
 * Scores a candidate, or returns 0 if it doesn't match. Every query word must
 * be a prefix of some word in some field. Whole-word matches beat prefix
 * matches, and heavier fields beat lighter ones. A field equal to the whole
 * query gets a large bonus, so "abbey road" ranks the album titled "Abbey
 * Road" above a song that merely mentions both words. A field starting with
 * the query gets only a small one, so "love" still ranks "All You Need Is
 * Love" above "Lovely Day".
 */
export function score(query: Query, fields: IndexedField[]): number {
  let total = 0;
  for (const qw of query.words) {
    let best = 0;
    for (const field of fields) {
      for (const w of field.words) {
        if (w === qw) best = Math.max(best, 3 * field.weight);
        else if (w.startsWith(qw)) best = Math.max(best, 2 * field.weight);
      }
    }
    if (best === 0) return 0;
    total += best;
  }
  for (const field of fields) {
    if (field.full === query.full) total += 10 * field.weight;
    // Less than the gap between a whole-word and a prefix match: a tiebreaker only.
    else if (field.full.startsWith(query.full)) total += 0.5 * field.weight;
  }
  return total;
}

/** The top `limit` candidates by score, ties broken by `compare`. */
export function rank<T>(
  query: Query,
  candidates: Iterable<T>,
  fieldsOf: (candidate: T) => IndexedField[],
  limit: number,
  compare: (a: T, b: T) => number,
): T[] {
  const scored: { candidate: T; score: number }[] = [];
  for (const candidate of candidates) {
    const s = score(query, fieldsOf(candidate));
    if (s > 0) scored.push({ candidate, score: s });
  }
  scored.sort((a, b) => b.score - a.score || compare(a.candidate, b.candidate));
  return scored.slice(0, limit).map((s) => s.candidate);
}
