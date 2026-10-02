import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type App } from "./app.js";
import type { Config, DiscordConfig } from "./config.js";

const INSTANCE = "i-1400000000000000001-gc-1100000000000000001-1100000000000000002";
const GUILD = "1100000000000000001";

const DISCORD: DiscordConfig = { clientId: "123", clientSecret: "secret", botToken: "bot", guildIds: new Set([GUILD]) };

interface FakeDiscord {
  /** OAuth codes Discord accepts. */
  codes?: string[];
  users?: string[];
  guildId?: string;
  down?: boolean;
}

/** Answers the three Discord API calls the session route makes. */
function fakeDiscord({ codes = ["good"], users = ["u1"], guildId = GUILD, down = false }: FakeDiscord = {}) {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  return (async (input: string | URL | Request, init?: RequestInit) => {
    if (down) throw new TypeError("fetch failed");
    const url = String(input);
    const auth = new Headers(init?.headers).get("Authorization");
    if (url.endsWith("/oauth2/token")) {
      const code = (init?.body as URLSearchParams).get("code") ?? "";
      return codes.includes(code) ? json({ access_token: `tok-${code}` }) : json({ error: "invalid_grant" }, 400);
    }
    if (url.endsWith("/users/@me")) {
      return auth === "Bearer tok-good" ? json({ id: "u1", username: "ada", global_name: "Ada" }) : json({}, 401);
    }
    if (url.includes(`/applications/123/activity-instances/`)) {
      if (auth !== "Bot bot") return json({}, 401);
      return url.endsWith(encodeURIComponent(INSTANCE))
        ? json({ location: { guild_id: guildId, channel_id: "c" }, users })
        : json({ message: "404: Not Found" }, 404);
    }
    return json({}, 404);
  }) as typeof fetch;
}

let ctx: App;
let dataDir: string;

async function start(discord: DiscordConfig | undefined, discordFetch = fakeDiscord()) {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lr-discord-"));
  const config: Config = {
    port: 0,
    dataDir,
    maxUploadBytes: 1024 * 1024,
    roomIdleTtlMs: 60_000,
    createRoomOnJoin: false,
    libraryRescanMs: 3_600_000,
    maxRoomBytes: Number.POSITIVE_INFINITY,
    discord,
  };
  ctx = await buildApp(config, { discordFetch });
}

afterEach(async () => {
  await ctx.app.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

const session = (body: unknown) =>
  ctx.app.inject({ method: "POST", url: "/api/discord/session", headers: { host: "relayer.example.com" }, payload: body as object });

describe("Discord Activity routes", () => {
  it("don't exist unless Discord is configured", async () => {
    await start(undefined);
    expect((await ctx.app.inject({ method: "GET", url: "/api/discord" })).statusCode).toBe(404);
    expect((await session({ code: "good", instanceId: INSTANCE })).statusCode).toBe(404);
    const root = await ctx.app.inject({ method: "GET", url: "/?frame_id=abc" });
    expect(root.headers.location).toBe("/start");
  });

  it("serve the client ID", async () => {
    await start(DISCORD);
    expect((await ctx.app.inject({ method: "GET", url: "/api/discord" })).json()).toEqual({ clientId: "123" });
  });

  it("create one room per instance and return it on every launch", async () => {
    await start(DISCORD);
    const first = await session({ code: "good", instanceId: INSTANCE });
    expect(first.statusCode).toBe(200);
    const body = first.json();
    expect(body).toMatchObject({ accessToken: "tok-good", name: "Ada" });
    expect(ctx.registry.has(body.roomId)).toBe(true);
    expect(body.webUrl).toBe(`https://relayer.example.com/r/${body.roomId}`);

    // A pop-out reloads the iframe and signs in again.
    expect((await session({ code: "good", instanceId: INSTANCE })).json().roomId).toBe(body.roomId);
  });

  it("make a new room once the instance's room has been swept", async () => {
    await start(DISCORD);
    const { roomId } = (await session({ code: "good", instanceId: INSTANCE })).json();
    ctx.registry["rooms"].delete(roomId);
    const again = (await session({ code: "good", instanceId: INSTANCE })).json();
    expect(again.roomId).not.toBe(roomId);
    expect(ctx.registry.has(again.roomId)).toBe(true);
  });

  it("reject bad requests and failed sign-ins without creating rooms", async () => {
    await start(DISCORD);
    expect((await session({ code: "good" })).statusCode).toBe(400);
    expect((await session({ code: "good", instanceId: "../../etc" })).statusCode).toBe(400);
    expect((await session({ code: "stale", instanceId: INSTANCE })).statusCode).toBe(401);
    expect((await session({ code: "good", instanceId: "i-999-gc-1-2" })).statusCode).toBe(403);
    expect(ctx.registry["rooms"].size).toBe(0);
  });

  it("reject users who aren't in the instance", async () => {
    await start(DISCORD, fakeDiscord({ users: ["someone-else"] }));
    expect((await session({ code: "good", instanceId: INSTANCE })).statusCode).toBe(403);
  });

  it("reject Discord servers that aren't on the allowlist", async () => {
    await start(DISCORD, fakeDiscord({ guildId: "999" }));
    const res = await session({ code: "good", instanceId: INSTANCE });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/isn't enabled/);
  });

  it("say so when Discord can't be reached", async () => {
    await start(DISCORD, fakeDiscord({ down: true }));
    expect((await session({ code: "good", instanceId: INSTANCE })).statusCode).toBe(502);
  });
});
