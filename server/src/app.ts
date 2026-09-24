import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import type { Config } from "./config.js";
import { Library } from "./library/library.js";
import { LocalDirSource } from "./library/source.js";
import { registerLibraryRoutes } from "./libraryRoutes.js";
import { MediaStore, registerMediaRoutes } from "./media.js";
import { RoomRegistry } from "./rooms.js";
import { Hub, registerWebSocket } from "./ws.js";
import { createYoutubeResolver, type YoutubeResolver } from "./youtube.js";

const clientDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../client/dist");

export interface AppOptions {
  logger?: boolean;
  youtube?: YoutubeResolver;
  /** Serve the built client when present (production). */
  serveClient?: boolean;
}

export interface App {
  app: FastifyInstance;
  registry: RoomRegistry;
  media: MediaStore;
  library: Library | null;
}

export async function buildApp(config: Config, options: AppOptions = {}): Promise<App> {
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 1024 * 1024 });
  const media = new MediaStore(config.dataDir);
  await media.init();

  const hub = new Hub();
  const registry = new RoomRegistry({
    idleTtlMs: config.roomIdleTtlMs,
    hooksFor: (roomId) => ({
      onChange: (room) => hub.scheduleSnapshot(room),
      onActivity: (entry) => hub.broadcast(roomId, { type: "activity", entries: [entry] }),
      onPresence: (room) => hub.schedulePresence(room),
      onItemsRemoved: (items) => media.removeItems(roomId, items.map((item) => item.id)),
    }),
    onDelete: (roomId) => media.removeRoom(roomId),
  });
  registry.start();

  const library = config.libraryDir
    ? new Library({
        source: new LocalDirSource(config.libraryDir),
        dataDir: config.dataDir,
        log: { info: (m) => app.log.info(m), warn: (m) => app.log.warn(m) },
      })
    : null;
  library?.start(config.libraryRescanMs);

  await app.register(fastifyWebsocket, { options: { maxPayload: 1024 * 1024 } });

  // Room creation lives entirely under /start so a proxy can put it behind
  // authentication: GET /start is the start page, and its form POSTs back to
  // /start. It is a plain form navigation, not fetch, so an auth portal's login
  // redirect works. Everything else (rooms, sockets, media, uploads) stays public.
  app.get("/", async (_request, reply) => reply.redirect("/start"));
  void app.register(async (scope) => {
    scope.addContentTypeParser(
      ["application/x-www-form-urlencoded", "multipart/form-data", "text/plain"],
      { parseAs: "string", bodyLimit: 1024 },
      (_request, _body, done) => done(null, {}),
    );
    scope.post("/start", async (_request, reply) => reply.redirect(`/r/${registry.create().id}`, 303));
  });

  /** Lets the room page say "not found" before asking for a name. */
  app.get<{ Params: { roomId: string } }>("/api/rooms/:roomId", async (request, reply) => {
    const { roomId } = request.params;
    const joinable = RoomRegistry.isValidId(roomId) && (registry.has(roomId) || config.createRoomOnJoin);
    return joinable ? { roomId } : reply.code(404).send({ error: "This room doesn't exist." });
  });

  registerMediaRoutes(app, registry, media, { maxUploadBytes: config.maxUploadBytes });
  registerLibraryRoutes(app, registry, library);
  registerWebSocket(app, registry, hub, options.youtube ?? createYoutubeResolver(), {
    createRoomOnJoin: config.createRoomOnJoin,
    library,
    media,
  });

  if (options.serveClient && existsSync(path.join(clientDist, "index.html"))) {
    // `index: false` leaves "/" to the redirect above.
    await app.register(fastifyStatic, { root: clientDist, wildcard: false, index: false });
    // Client-side routes (/start, /r/:roomId) fall back to the single-page app.
    app.setNotFoundHandler((request, reply) => {
      const url = request.raw.url ?? "";
      if (request.method !== "GET" || /^\/(api|media|ws)(\/|$)/.test(url)) {
        return reply.code(404).send({ error: "Not found." });
      }
      return reply.type("text/html").sendFile("index.html");
    });
  }

  app.addHook("onClose", async () => {
    hub.closeAll();
    registry.stop();
    library?.stop();
  });

  return { app, registry, media, library };
}
