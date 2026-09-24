import type { YouTubeResult, YouTubeStatus } from "@relayer/shared";

/** The room-scoped YouTube search endpoints (SPEC §14). */
export class YouTubeApi {
  private readonly base: string;

  constructor(roomId: string) {
    this.base = `/api/rooms/${encodeURIComponent(roomId)}/youtube`;
  }

  status(): Promise<YouTubeStatus> {
    return this.get("");
  }

  async search(q: string, signal?: AbortSignal): Promise<YouTubeResult[]> {
    const { results } = await this.get<{ results: YouTubeResult[] }>(`/search?q=${encodeURIComponent(q)}`, signal);
    return results;
  }

  private async get<T>(path: string, signal?: AbortSignal): Promise<T> {
    const response = await fetch(this.base + path, { signal });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `Request failed (${response.status}).`);
    }
    return (await response.json()) as T;
  }
}
