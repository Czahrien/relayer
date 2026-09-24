import type { FastifyInstance, FastifyReply } from "fastify";
import type { LibraryStatus } from "@relayer/shared";
import type { Library } from "./library/library.js";
import { sendImage } from "./media.js";
import type { RoomRegistry } from "./rooms.js";

const MAX_QUERY = 200;

type RoomParams = { roomId: string };

/**
 * Library browsing, scoped to rooms (SPEC §10.4): every endpoint answers 404
 * unless the room exists, and responses carry IDs and metadata, never paths.
 */
export function registerLibraryRoutes(app: FastifyInstance, registry: RoomRegistry, library: Library | null): void {
  /** Replies 404 and returns null unless the room exists and the library is enabled. */
  function guard(roomId: string, reply: FastifyReply): Library | null {
    if (!registry.has(roomId)) {
      void reply.code(404).send({ error: "This room doesn't exist." });
      return null;
    }
    if (!library) {
      void reply.code(404).send({ error: "The library isn't enabled." });
      return null;
    }
    return library;
  }

  app.get<{ Params: RoomParams }>("/api/rooms/:roomId/library", async (request, reply) => {
    if (!registry.has(request.params.roomId)) return reply.code(404).send({ error: "This room doesn't exist." });
    const status: LibraryStatus = {
      enabled: library !== null,
      indexing: library?.indexing ?? false,
      trackCount: library?.trackCount ?? 0,
    };
    return status;
  });

  app.get<{ Params: RoomParams; Querystring: { q?: string } }>(
    "/api/rooms/:roomId/library/search",
    async (request, reply) => {
      const lib = guard(request.params.roomId, reply);
      if (!lib) return reply;
      const q = request.query.q ?? "";
      if (q.length > MAX_QUERY) return reply.code(400).send({ error: "That search is too long." });
      return lib.search(q);
    },
  );

  app.get<{ Params: RoomParams & { albumId: string } }>(
    "/api/rooms/:roomId/library/albums/:albumId",
    async (request, reply) => {
      const lib = guard(request.params.roomId, reply);
      if (!lib) return reply;
      return lib.album(request.params.albumId) ?? reply.code(404).send({ error: "That album isn't in the library." });
    },
  );

  app.get<{ Params: RoomParams & { albumId: string } }>(
    "/api/rooms/:roomId/library/albums/:albumId/art",
    async (request, reply) => {
      const lib = guard(request.params.roomId, reply);
      if (!lib) return reply;
      const art = lib.albumArt(request.params.albumId);
      return art ? sendImage(reply, art.file, art.mime) : reply.code(404).send({ error: "Not found." });
    },
  );

  // The name is a query parameter so names like "AC/DC" survive intact.
  app.get<{ Params: RoomParams; Querystring: { name?: string } }>(
    "/api/rooms/:roomId/library/artist",
    async (request, reply) => {
      const lib = guard(request.params.roomId, reply);
      if (!lib) return reply;
      const name = request.query.name ?? "";
      if (!name || name.length > MAX_QUERY) return reply.code(400).send({ error: "Give an artist name." });
      return lib.artist(name) ?? reply.code(404).send({ error: "That artist isn't in the library." });
    },
  );
}
