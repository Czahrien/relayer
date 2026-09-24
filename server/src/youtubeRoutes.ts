import type { FastifyInstance } from "fastify";
import type { YouTubeResult, YouTubeStatus } from "@relayer/shared";
import { CommandError } from "./room.js";
import type { RoomRegistry } from "./rooms.js";
import type { YouTubeData } from "./youtubeApi.js";

const MAX_QUERY = 200;
/**
 * The default quota is 100 searches a day for the whole server, so one busy
 * room mustn't use it all: bursts of 10, then one every 2 minutes. Repeated
 * searches are answered from the cache and don't count against YouTube.
 */
const SEARCH_BURST = 10;
const SEARCH_REFILL_MS = 2 * 60_000;

type RoomParams = { roomId: string };

/** YouTube search, scoped to rooms like the library (SPEC §14). */
export function registerYoutubeRoutes(
  app: FastifyInstance,
  registry: RoomRegistry,
  youtube: YouTubeData | null,
  now: () => number = Date.now,
): void {
  const budgets = new Map<string, { tokens: number; refilledAt: number }>();

  function allowSearch(roomId: string): boolean {
    const t = now();
    const budget = budgets.get(roomId) ?? { tokens: SEARCH_BURST, refilledAt: t };
    const refill = Math.floor((t - budget.refilledAt) / SEARCH_REFILL_MS);
    if (refill > 0) {
      budget.tokens = Math.min(SEARCH_BURST, budget.tokens + refill);
      budget.refilledAt = budget.tokens === SEARCH_BURST ? t : budget.refilledAt + refill * SEARCH_REFILL_MS;
    }
    budgets.set(roomId, budget);
    if (budget.tokens === 0) return false;
    budget.tokens--;
    return true;
  }

  app.get<{ Params: RoomParams }>("/api/rooms/:roomId/youtube", async (request, reply) => {
    if (!registry.has(request.params.roomId)) return reply.code(404).send({ error: "This room doesn't exist." });
    const status: YouTubeStatus = { enabled: youtube !== null };
    return status;
  });

  app.get<{ Params: RoomParams; Querystring: { q?: string } }>(
    "/api/rooms/:roomId/youtube/search",
    async (request, reply) => {
      const { roomId } = request.params;
      if (!registry.has(roomId)) return reply.code(404).send({ error: "This room doesn't exist." });
      if (!youtube) return reply.code(404).send({ error: "YouTube search isn't enabled on this server." });
      const q = (request.query.q ?? "").trim();
      if (!q) return { results: [] satisfies YouTubeResult[] };
      if (q.length > MAX_QUERY) return reply.code(400).send({ error: "That search is too long." });
      if (!allowSearch(roomId)) {
        return reply.code(429).send({ error: "This room has searched YouTube a lot lately. Try again in a few minutes." });
      }
      try {
        return { results: await youtube.search(q) };
      } catch (err) {
        if (err instanceof CommandError) return reply.code(503).send({ error: err.message });
        throw err;
      }
    },
  );
}
