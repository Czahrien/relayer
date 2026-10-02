# Relayer as a Discord Activity: proposal

Status: built; SPEC §15 describes the behavior, and the code sketches below are the original proposal. This file keeps the research, the spike results, and the reasoning. Researched 2026-10-02 against Discord's current Activities docs and the live `discordsays.com` proxy.

## Summary

A Discord Activity is a web page that Discord loads in an iframe inside a voice channel (or a text channel or DM). Everyone who joins the Activity in that channel shares one **instance**. That matches Relayer's model closely: each Activity instance becomes one Relayer room, every participant's iframe runs the normal Relayer client, and audio plays locally in each iframe from the shared timeline, exactly as it does in a browser today. The server, the protocol, the queue, and the sync engine need no changes.

What changes:

- **One new server route** (`POST /api/discord/session`) that exchanges Discord's OAuth code, checks that the user really is in that Activity instance, and returns a room ID.
- **A client bootstrap** that runs the Discord SDK handshake instead of the `/r/:roomId` URL and join overlay.
- **YouTube does not work inside the Activity** (see [YouTube](#youtube-blocked-by-discords-csp)). Uploads and the server library do. This is the main limitation, and it isn't something Relayer can fix.

## How Activities work (research notes)

- **Hosting.** The page is served from `https://<client-id>.discordsays.com/`, which Discord proxies (Cloudflare Workers) to targets you configure as **URL mappings** in the Developer Portal. A mapping of `/` → `relayer.example.com` sends every path to the Relayer server, so the client's relative `/api`, `/media`, and `/ws` URLs work unchanged. WebSockets are supported; WebRTC is not. (The `/.proxy/` prefix seen in older examples no longer appears in the docs; the root mapping is the current pattern.)
- **Sandbox.** The proxy sends a strict CSP. For a typical third-party app (checked live on several published Activities) it is:

  ```
  default-src 'self'; script-src 'self' 'unsafe-eval' 'nonce-…' blob:;
  connect-src https://<id>.discordsays.com/ wss://<id>.discordsays.com/ https://discord.com … ;
  media-src 'self' blob: data:; img-src 'self' blob: data: https://cdn.discordapp.com …;
  frame-src https://<id>.discordsays.com/ …
  ```

  Relayer's built client has no inline scripts and no external origins (fonts, art, and media are all same-origin), so it fits within this. `<audio>` from `/media/…` is allowed by `media-src 'self'`.
- **Lifecycle.** The iframe URL carries query parameters (`instance_id`, `frame_id`, `channel_id`, `guild_id`, `platform`, …) that the SDK reads on construction. `discordSdk.instanceId` is available immediately. Everyone who joins gets the same `instanceId`; when the last participant leaves, the instance ends and is never reused.
- **Auth.** `sdk.ready()` → `sdk.commands.authorize({ scope: ["identify"] })` returns an OAuth `code` → the app's server exchanges it at `https://discord.com/api/oauth2/token` using the client secret → `sdk.commands.authenticate({ access_token })`. `discord.com/api` is exempt from the CSP, so the server-side calls are ordinary `fetch` calls.
- **Trust.** The docs say plainly not to trust anything the Discord client tells you (user, channel, and so on). The page is publicly reachable at `discordsays.com` and the RPC can be faked. The recommended check is the **Activity Instance API**, `GET /applications/<app-id>/activity-instances/<instance-id>` with the app's bot token, which returns `{ location: { guild_id, channel_id }, users: [...] }` or 404.
- **Launching.** Members launch it from the App Launcher (the rocket button in a voice channel). Enabling Activities creates a default "Launch" Entry Point command. A bot interaction can also respond with `LAUNCH_ACTIVITY`.
- **Layout.** The Activity can be focused, picture-in-picture, or a grid tile. `subscribeToLayoutModeUpdatesCompat` reports which. Platforms (web/desktop, iOS, Android) are opted into separately in the portal. Mobile safe areas come through `--discord-safe-area-inset-*` CSS variables.
- **Platform limits.** Discord's proxy strips cache headers from `text/html` only, so hashed Vite assets are fine. Dev setup is one "development" app per developer, pointed at a cloudflared tunnel.

## YouTube: blocked by Discord's CSP

The CSP is **per application**. Discord's own Watch Together app (`880218394199220334`) is allowed `script-src https://www.youtube.com`, `frame-src https://www.youtube.com`, and `img-src https://i.ytimg.com`. Every third-party Activity checked gets only its own proxy for `script-src`, `frame-src`, and `media-src`. A self-service app therefore cannot load `https://www.youtube.com/iframe_api` or create the embed iframe.

Workarounds don't hold up:

- **Proxying YouTube through URL mappings** (`/yt` → `www.youtube.com` plus `patchUrlMappings`) gets the iframe past `frame-src`, but the proxied YouTube document gets the same CSP. Its inline scripts lack the nonce, and the video streams come from `*.googlevideo.com`, which isn't allowed. It also amounts to re-serving YouTube's player, which runs against YouTube's embed terms and the project's rule of playing YouTube only through the official embed.
- **Asking Discord for a CSP exception.** Some apps clearly have custom CSPs (one has Google's ad domains), so exceptions exist, but there is no documented self-service process. It might be worth asking Discord developer support, but don't plan around it.

**Proposal:** inside the Activity, `YouTubePlayer` fails fast with `LocalError`. That reuses the existing local-refusal path (§6.5): the item is skipped for the room only once every listener has failed. In an all-Discord room that means a quick skip. In a mixed room (some people on the web link), web listeners hear it and Discord listeners see "YouTube can't play inside Discord". The Activity UI also hides YouTube search and link pasting so people don't queue things they can't hear.

## Proposed architecture

```
 Discord client (voice channel)                 Relayer server (unchanged core)
┌──────────────────────────────────┐           ┌────────────────────────────────────┐
│ iframe: <app-id>.discordsays.com │           │  GET /            → SPA (if frame_id)│
│  ┌────────────────────────────┐  │  proxy    │  GET /api/discord → { clientId }   │
│  │ Relayer client             │──┼──────────▶│  POST /api/discord/session  (new)  │
│  │  discord.ts bootstrap      │  │  "/" →    │     ├─ oauth2/token (code→token)   │
│  │  RoomPage / sync engine    │  │  relayer  │     ├─ users/@me                   │
│  │  FilePlayer <audio>        │  │  .example │     └─ activity-instances/<id> ✓   │
│  └────────────────────────────┘  │  .com     │  /ws/:roomId, /media/…, /api/rooms │
└──────────────────────────────────┘           └────────────────────────────────────┘
```

### Launch flow

1. A member clicks Relayer in the App Launcher. Discord loads `/?instance_id=…&frame_id=…`.
2. The client sees `frame_id`, fetches `GET /api/discord` for the client ID, constructs `DiscordSDK`, and awaits `ready()`.
3. `authorize({ scope: ["identify"] })` returns a code (the first time, Discord shows a consent modal).
4. `POST /api/discord/session { code, instanceId }`. The server exchanges the code, fetches the user, fetches the instance with the bot token, and checks that the user is in `instance.users` and the guild is allowed. It then finds or creates the room for that instance and returns `{ accessToken, roomId, name }`.
5. The client calls `authenticate({ access_token })`, needed only for SDK commands such as the invite dialog, and renders `RoomPage` for `roomId`. A one-tap "Join and listen" button stays, because it is the user gesture that unlocks `<audio>`, which matters even more in the iOS app's webview.
6. From here everything is normal Relayer: `hello`, snapshots, and the clock and sync engine over `/ws/:roomId` through the proxy.

### Room mapping

The server keeps a `Map<instanceId, roomId>` and creates rooms with the existing `registry.create()`, so Activity rooms get the same random, unguessable names as `/start` rooms. Activity rooms are therefore ordinary rooms: anyone with the room ID can also join from a browser at `/r/<roomId>`. That gives a mixed room and an escape hatch for YouTube. When the instance ends and everyone leaves, the room goes idle and is swept by the existing `ROOM_IDLE_TTL_MIN` logic.

Using `instanceId` directly as the room ID would also pass `ROOM_ID_PATTERN` (about 62 characters, against a 64 limit). It isn't secret, though, since it is built from guild and channel snowflakes, and it would make the room joinable by anyone who can guess it.

### Access control

Today, room creation is protected by Caddy on `/start` with `CREATE_ROOM_ON_JOIN=false`. The Activity bypasses `/start`, so the session route must enforce its own rule. Otherwise anyone who can launch the app gets access to the library and to upload storage.

- **Instance check** (above): proves the caller is a real participant in a real instance of *this* app.
- **Guild allowlist** (`DISCORD_GUILD_IDS`): only those servers can create rooms. Also turn off the **User Install** context in the portal, so the app can't be added to and launched from arbitrary servers and DMs.
- Discord can also sign proxied requests (`X-Signature-Ed25519` and related headers). That is optional and redundant with the instance check, so skip it.

### Configuration

| Variable | Purpose |
| - | - |
| `DISCORD_CLIENT_ID` | App ID. Served to the client by `GET /api/discord`, so the published image needs no build-time value. |
| `DISCORD_CLIENT_SECRET` | OAuth code exchange. |
| `DISCORD_BOT_TOKEN` | Activity Instance API. The bot never joins voice or needs gateway intents. |
| `DISCORD_GUILD_IDS` | Comma-separated allowlist. Required; unset disables the feature. |

Developer Portal: enable Activities; set the URL mapping `/` → `relayer.example.com`; add OAuth2 redirect `https://127.0.0.1` (required by the portal even though the SDK flow doesn't use it); choose supported platforms; turn off User Install.

## Code sketches

These are sketches, not tested code. Names follow the existing codebase.

### Server: config (`server/src/config.ts`)

```ts
export interface DiscordConfig {
  clientId: string;
  clientSecret: string;
  botToken: string;
  guildIds: Set<string>;
}

// in Config:
  /** Discord Activity (docs/discord-activity.md); undefined disables it. */
  discord?: DiscordConfig;

// in loadConfig():
function discordConfig(): DiscordConfig | undefined {
  const { DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_BOT_TOKEN, DISCORD_GUILD_IDS } = process.env;
  if (!DISCORD_CLIENT_ID) return undefined;
  if (!DISCORD_CLIENT_SECRET || !DISCORD_BOT_TOKEN || !DISCORD_GUILD_IDS) {
    throw new Error("DISCORD_CLIENT_ID needs DISCORD_CLIENT_SECRET, DISCORD_BOT_TOKEN, and DISCORD_GUILD_IDS");
  }
  return {
    clientId: DISCORD_CLIENT_ID,
    clientSecret: DISCORD_CLIENT_SECRET,
    botToken: DISCORD_BOT_TOKEN,
    guildIds: new Set(DISCORD_GUILD_IDS.split(",").map((id) => id.trim()).filter(Boolean)),
  };
}
```

### Server: routes (`server/src/discordRoutes.ts`)

```ts
import type { FastifyInstance } from "fastify";
import type { DiscordConfig } from "./config.js";
import type { RoomRegistry } from "./rooms.js";

const API = "https://discord.com/api/v10";

interface ActivityInstance {
  location: { guild_id?: string; channel_id: string };
  users: string[];
}

export function registerDiscordRoutes(app: FastifyInstance, discord: DiscordConfig, registry: RoomRegistry): void {
  // ponytail: never pruned; a stale entry just misses registry.has() and gets replaced.
  const roomByInstance = new Map<string, string>();

  app.get("/api/discord", async () => ({ clientId: discord.clientId }));

  app.post<{ Body: { code?: unknown; instanceId?: unknown } }>("/api/discord/session", async (request, reply) => {
    const { code, instanceId } = request.body ?? {};
    if (typeof code !== "string" || typeof instanceId !== "string" || instanceId.length > 128) {
      return reply.code(400).send({ error: "Bad request." });
    }

    const token = await discordJson<{ access_token: string }>("/oauth2/token", {
      method: "POST",
      body: new URLSearchParams({
        client_id: discord.clientId,
        client_secret: discord.clientSecret,
        grant_type: "authorization_code",
        code,
      }),
    });
    const user = await discordJson<{ id: string; username: string; global_name: string | null }>("/users/@me", {
      headers: { Authorization: `Bearer ${token?.access_token}` },
    });
    const instance = await discordJson<ActivityInstance>(
      `/applications/${discord.clientId}/activity-instances/${encodeURIComponent(instanceId)}`,
      { headers: { Authorization: `Bot ${discord.botToken}` } },
    );

    if (!token || !user || !instance?.users.includes(user.id)) {
      return reply.code(403).send({ error: "You're not in this Activity." });
    }
    if (!instance.location.guild_id || !discord.guildIds.has(instance.location.guild_id)) {
      return reply.code(403).send({ error: "Relayer isn't enabled for this server." });
    }

    let roomId = roomByInstance.get(instanceId);
    if (!roomId || !registry.has(roomId)) {
      roomId = registry.create().id;
      roomByInstance.set(instanceId, roomId);
    }
    return { accessToken: token.access_token, roomId, name: user.global_name ?? user.username };
  });
}

/** Parsed JSON for a 2xx response, otherwise null. */
async function discordJson<T>(path: string, init: RequestInit): Promise<T | null> {
  const response = await fetch(API + path, init);
  return response.ok ? ((await response.json()) as T) : null;
}
```

Register it in `buildApp` next to the library and YouTube routes, with `if (config.discord) registerDiscordRoutes(app, config.discord, registry);`.

### Server: serve the SPA at `/` for Discord (`server/src/app.ts`)

Discord loads the mapping root, `/?frame_id=…`. Today `/` redirects to `/start`, which sits behind Caddy auth, so the Activity would land on a login page. Serve the app instead when the request is a Discord launch:

```ts
app.get<{ Querystring: { frame_id?: string } }>("/", async (request, reply) =>
  request.query.frame_id && config.discord ? reply.sendFile("index.html") : reply.redirect("/start"),
);
```

`sendFile` comes from `@fastify/static`, which is only registered when the client is built. In dev, Vite serves `/` itself.

### Client: bootstrap (`client/src/lib/discord.ts`)

```ts
import { DiscordSDK } from "@discord/embedded-app-sdk";

/** Discord adds frame_id (and instance_id, etc.) to the Activity's URL. */
export const inDiscord = new URLSearchParams(location.search).has("frame_id");

export interface ActivitySession {
  sdk: DiscordSDK;
  roomId: string;
  name: string;
}

export async function startActivity(): Promise<ActivitySession> {
  const { clientId } = (await (await fetch("/api/discord")).json()) as { clientId: string };
  const sdk = new DiscordSDK(clientId);
  await sdk.ready();

  const { code } = await sdk.commands.authorize({
    client_id: clientId,
    response_type: "code",
    state: "",
    prompt: "none",
    scope: ["identify"],
  });
  const response = await fetch("/api/discord/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, instanceId: sdk.instanceId }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? "Couldn't start Relayer.");

  await sdk.commands.authenticate({ access_token: body.accessToken });
  return { sdk, roomId: body.roomId, name: body.name };
}
```

### Client: routing (`client/src/App.svelte`)

```svelte
<script lang="ts">
  import { inDiscord, startActivity } from "./lib/discord.js";
  // ...existing imports and path/roomId/isStart...

  $effect(() => {
    if (!inDiscord && !roomId && !isStart) location.replace("/start");
  });
</script>

{#if inDiscord}
  {#await startActivity()}
    <!-- a quiet loading state -->
  {:then activity}
    <RoomPage roomId={activity.roomId} {activity} />
  {:catch error}
    <RoomMissing message={error.message} />
  {/await}
{:else if roomId}
  ...
```

Don't navigate to `/r/:roomId` inside the Activity. The SDK has already read the query string, but a full navigation would lose it on reload, and the URL isn't visible anyway.

### Client: small UI adjustments when `activity` is set

- **Join overlay:** prefill the name from `activity.name`, hide the name field, and keep the button. That tap is the audio-unlock gesture.
- **Header share button:** a `discordsays.com` URL is useless to share. Use `activity.sdk.commands.openInviteDialog()` instead (guild channels only). Optionally add an "Open in browser" item that calls `openExternalLink` with a public `/r/<roomId>` URL, which is the way into YouTube for that room.
- **YouTube:** hide YouTube search and paste-to-queue, and make the player refuse up front:

  ```ts
  // YouTubePlayer.load(), before loadApi()
  if (inDiscord) throw new LocalError("YouTube can't play inside Discord.");
  ```

- **Picture-in-picture (optional):** `sdk.subscribeToLayoutModeUpdatesCompat` reports PIP and grid modes, where a compact art-and-title view fits better than the full layout.
- **Rich presence (optional, later):** `sdk.commands.setActivity` can show "Listening to *title*" on profiles. It needs the `rpc.activities.write` scope.

### Dev setup (`client/vite.config.ts`)

Run a dev Discord app against a tunnel to Vite (`cloudflared tunnel --url http://localhost:5173`, then map `/` to the tunnel host in the portal). Vite must accept the tunnel host and run HMR over the proxy's port 443:

```ts
server: {
  host: true,
  allowedHosts: [".trycloudflare.com"],
  hmr: { clientPort: 443 },
  proxy: { /* unchanged */ },
},
```

## Unknowns to settle in a spike

Ordered by how much each could change the plan:

1. **Range requests and large media through the proxy.** `/media` needs `Range` (Safari, seeking) and serves files of many MB. Confirm the proxy passes `Range`/`206` and doesn't buffer or cap responses. This is the biggest risk for file playback.
2. **Upload size through the proxy.** Cloudflare caps request bodies (often 100 MB). The 300 MB `MAX_UPLOAD_MB` default may fail in the Activity. If so, show a clear message, or point people to the library.
3. **Audio in the iOS and Android webviews.** Check that the join-tap unlock works and that audio keeps playing in PIP and when the Discord app is backgrounded. Discord's design guide says device volume buttons work as expected.
4. **Clock sync over the proxy.** Expect higher and jitterier ping RTT. `clock.ts` filters on RTT so it should cope, but check the `?debug` panel numbers. (`?debug` won't exist in the Activity URL, so the debug panel needs another toggle there.)
5. **Server egress to discord.com.** Discord warns that some shared or cloud IPs are Cloudflare-banned. A VPS with a static IP should be fine.

The first three can be tested with no Relayer changes: map `/` to the existing deployment, add `?frame_id` handling at `/`, and play a library track without the SDK. If `<audio>` seeks correctly there, the rest is straightforward.

### Spike results (2026-10-02, desktop client)

The spike (branch `discord-spike`) ran the SDK handshake only, then asked for the ID of a room created in a browser.

- **Handshake:** works. `platform` was `desktop`, and the instance ID has the documented shape (`i-<launch>-gc-<guild>-<channel>`).
- **Playback and sync:** library tracks play through the proxy and stay in sync with a browser listener. Seeking works from either side. Range requests therefore pass through the proxy (unknown 1).
- **Uploads:** the "Add files / folder" buttons work. **Drag and drop does not**, because Discord captures dropped files (to send them as attachments) before they reach the iframe. Hide the drop hint in the Activity and rely on the buttons. **Uploads are capped at 128 MiB** (unknown 2): Discord's proxy answers larger bodies with its own `500` page ("Discord Activity not available at this time"), and the request never reaches the server. Bisected by sending `PUT`s straight to `https://<app-id>.discordsays.com`: 127 MiB reached the server and 128 MiB didn't. The cloudflared tunnel passed 150 MB, so the cap is Discord's. The failure also showed that an upload failing before the server sees it left the item `uploading` forever, which stalled the room when it was current. Hence the client-side cap and the `uploadFailed` message.
- **YouTube:** the embed stays black with no audio, as the CSP predicted. Inside Discord it must fail fast with `LocalError`, so a room where everyone is in Discord skips the item instead of retrying it.
- **Fullscreen** works.
- **Pop-out reloads the iframe**, so the spike lost both the room ID and the name. Reloads must be cheap. The real design already covers both: the room comes from `instanceId` through the server's map, and the name comes from Discord. The one-tap join stays, because a reload loses the audio unlock. The name also didn't survive through `prefs` (localStorage), which suggests the pop-out window has its own storage partition, so don't rely on browser storage in the Activity.
- **iOS (2026-10-02, full build):** the first launch showed a white page for about 30 seconds, then Relayer's `/start` landing page. That means a load arrived without `frame_id`, and "Start a session" then made an ordinary browser room, whose join button stays disabled until a name is typed. The server answered `/?frame_id=…&platform=mobile` correctly when tested directly, and rejoining worked normally, so the cause is unknown and it may be intermittent. If it recurs, capture the server's request log for the launch (does the first `GET /` carry `frame_id`, and does anything arrive during the white period?) and Discord's mobile Debug Logs. The header's room name also wraps badly on a phone (see the SPEC stretch list).
- **Mobile audio (unknown 3), iOS and Android:** audio keeps playing in picture-in-picture, fullscreen, and with Discord in the background. The PIP view itself is useless (it shows a small piece of the progress bar), so it belongs in the mobile layout pass.
- **Clock sync over the proxy (unknown 4):** closed on what we heard. Discord and browser listeners stayed audibly in sync on desktop, iOS, and Android, with no seek stutters on iOS (which corrects by seeking only, §6.8). No round-trip time or offset numbers were captured. If sync complaints come up, the header's per-listener sync dots and the debug panel (D) are the place to look.
- All spike unknowns are closed.

## Estimated scope

- Server: about 100 lines (config, `discordRoutes.ts`, the `/` change) plus tests driving `buildApp` with a stubbed `fetch`.
- Client: about 60 lines (`discord.ts`, App routing, the UI conditionals) and one dependency, `@discord/embedded-app-sdk`.
- Docs: a SPEC section, README configuration rows, and a Caddy note that `/` must stay unauthenticated (it already is).

## Sources

- [Activities: How Activities Work](https://docs.discord.com/developers/activities/how-activities-work)
- [Activities: Networking](https://docs.discord.com/developers/activities/development-guides/networking) (proxy, CSP, `patchUrlMappings`, cookies)
- [Activities: Local Development](https://docs.discord.com/developers/activities/development-guides/local-development) (URL mappings, CSP exceptions, tunnels)
- [Activities: Multiplayer Experience](https://docs.discord.com/developers/activities/development-guides/multiplayer-experience) (`instanceId`, participants, Activity Instance API, proxy signatures)
- [Activities: Layout](https://docs.discord.com/developers/activities/development-guides/layout), [Mobile](https://docs.discord.com/developers/activities/development-guides/mobile), [Production Readiness](https://docs.discord.com/developers/activities/development-guides/production-readiness), [Design Patterns](https://docs.discord.com/developers/activities/design-patterns)
- [Building an Activity tutorial](https://docs.discord.com/developers/activities/building-an-activity) (OAuth code exchange)
- [Embedded App SDK reference](https://docs.discord.com/developers/developer-tools/embedded-app-sdk)
- [`patchUrlMappings` notes](https://github.com/discord/embedded-app-sdk/blob/main/patch-url-mappings.md)
- CSP headers observed with `curl -I https://<app-id>.discordsays.com/` for Watch Together (`880218394199220334`) and several third-party Activities, 2026-10-02.
