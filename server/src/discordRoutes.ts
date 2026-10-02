import type { FastifyInstance } from "fastify";
import type { DiscordConfig as PublicDiscordConfig, DiscordSession } from "@relayer/shared";
import type { DiscordConfig } from "./config.js";
import type { RoomRegistry } from "./rooms.js";

const API = "https://discord.com/api/v10";
const TIMEOUT_MS = 10_000;
/** Instance IDs look like i-<launch>-gc-<guild>-<channel>. */
const INSTANCE_ID = /^[\w-]{1,128}$/;

interface ActivityInstance {
  location: { guild_id?: string; channel_id: string };
  users: string[];
}

interface DiscordUser {
  id: string;
  username: string;
  global_name: string | null;
}

/**
 * Discord Activity sign-in (SPEC §15). The session route is the Activity's
 * only way to create a room, so it checks with Discord (not the client) that
 * the caller is in a live instance of this app in an allowed server.
 */
export function registerDiscordRoutes(
  app: FastifyInstance,
  registry: RoomRegistry,
  discord: DiscordConfig,
  fetchImpl: typeof fetch = fetch,
): void {
  // ponytail: never pruned; entries are tiny, and a stale one just misses registry.has() and is replaced.
  const roomByInstance = new Map<string, string>();

  /** Parsed JSON for a 2xx response, otherwise null. Throws only when Discord can't be reached. */
  async function discordJson<T>(path: string, init: RequestInit): Promise<T | null> {
    const response = await fetchImpl(API + path, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    return response.ok ? ((await response.json()) as T) : null;
  }

  app.get("/api/discord", async () => ({ clientId: discord.clientId }) satisfies PublicDiscordConfig);

  app.post<{ Body: { code?: unknown; instanceId?: unknown } | null }>("/api/discord/session", async (request, reply) => {
    const { code, instanceId } = request.body ?? {};
    if (typeof code !== "string" || code.length > 512 || typeof instanceId !== "string" || !INSTANCE_ID.test(instanceId)) {
      return reply.code(400).send({ error: "Bad sign-in request." });
    }

    let token: { access_token: string } | null;
    let user: DiscordUser | null = null;
    let instance: ActivityInstance | null = null;
    try {
      token = await discordJson("/oauth2/token", {
        method: "POST",
        body: new URLSearchParams({
          client_id: discord.clientId,
          client_secret: discord.clientSecret,
          grant_type: "authorization_code",
          code,
        }),
      });
      if (token) {
        [user, instance] = await Promise.all([
          discordJson<DiscordUser>("/users/@me", { headers: { Authorization: `Bearer ${token.access_token}` } }),
          discordJson<ActivityInstance>(
            `/applications/${discord.clientId}/activity-instances/${encodeURIComponent(instanceId)}`,
            { headers: { Authorization: `Bot ${discord.botToken}` } },
          ),
        ]);
      }
    } catch (err) {
      request.log.warn({ err }, "Discord API unreachable");
      return reply.code(502).send({ error: "Couldn't reach Discord. Try again in a moment." });
    }

    if (!token || !user) return reply.code(401).send({ error: "Discord sign-in failed. Try relaunching the Activity." });
    if (!instance?.users.includes(user.id)) return reply.code(403).send({ error: "You're not in this Activity." });
    const guildId = instance.location.guild_id;
    if (!guildId || !discord.guildIds.has(guildId)) {
      return reply.code(403).send({ error: "Relayer isn't enabled for this Discord server." });
    }

    let roomId = roomByInstance.get(instanceId);
    if (!roomId || !registry.has(roomId)) {
      roomId = registry.create().id;
      roomByInstance.set(instanceId, roomId);
    }
    // Discord's proxy requests the URL mapping's target host, which is the server's public name.
    const webUrl = `https://${request.host}/r/${roomId}`;
    return {
      accessToken: token.access_token,
      roomId,
      name: user.global_name || user.username,
      webUrl,
    } satisfies DiscordSession;
  });
}
