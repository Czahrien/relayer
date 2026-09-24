import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import type { Config } from "./config.js";
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

  await app.register(fastifyWebsocket, { options: { maxPayload: 1024 * 1024 } });

  app.post("/api/rooms", async () => ({ roomId: registry.create().id }));
  registerMediaRoutes(app, registry, media, { maxUploadBytes: config.maxUploadBytes });
  registerWebSocket(app, registry, hub, options.youtube ?? createYoutubeResolver());

  if (options.serveClient && existsSync(path.join(clientDist, "index.html"))) {
    await app.register(fastifyStatic, { root: clientDist, wildcard: false });
    // Client-side routes (/r/:roomId) fall back to the single-page app.
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
  });

  return { app, registry, media };
}
