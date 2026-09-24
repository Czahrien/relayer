import { parseYouTubeUrl } from "@relayer/shared";

export type ChatSegment = { text: string } | { url: string; youtube: boolean };

/**
 * Splits a chat message into text and links. Only http(s) and "www." links
 * are linked (never javascript: or other schemes), and trailing punctuation
 * stays text: "see https://x.com/a." links "https://x.com/a".
 */
export function chatSegments(text: string): ChatSegment[] {
  const out: ChatSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(/\b(?:https?:\/\/|www\.)[^\s<>"]*[^\s<>".,;:!?)\]'”’]/gi)) {
    if (match.index > last) out.push({ text: text.slice(last, match.index) });
    const url = /^www\./i.test(match[0]) ? `https://${match[0]}` : match[0];
    out.push({ url, youtube: !!parseYouTubeUrl(url) });
    last = match.index + match[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}
