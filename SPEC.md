# Relayer: Spec

*(Named after the 1974 Yes album: the server relays one shared timeline to every listener.)* This is a small self-hosted web app. Someone starts a room and shares its link. Anyone who opens the link lands in the same room, where they build a shared queue by dragging in audio files, whole album folders, or YouTube links, and everyone hears the same thing at the same moment.

This document records the decisions already made and the reasons behind them, so implementation stays consistent. Anything marked **Stretch** is out of scope for now. If something here turns out to be wrong or impractical during implementation, flag it rather than silently working around it.

**Status.** The first vertical slice (§12, milestones 1–5) is built, along with the changes decided while deploying it: room creation under `/start` so it can sit behind authentication (§5), readable room names (§5), Docker packaging (§13), license notices (§13), and the Safari sync fixes (§6.8). The server library (§10, milestones 6–8) is built. The next milestone is YouTube search (§14).

---

## 1. Goals and non-goals

### Slice goals

- **Rooms.** Anyone allowed to start a room can do so and share its URL, and anyone with the URL can join with a display name.
- **Shared queue.** The queue accepts individual audio files, whole album folders, and YouTube links.
- **Synchronized playback.** Clients stay in sync with each other. The targets are within ~100 ms for files and ~500 ms for YouTube.
- **Now playing.** A now-playing view shows metadata, art, position and duration, and a seekable progress bar. It has play/pause, previous, next, and restart controls.
- **History.** Songs that have already played stay visible in the queue as history until someone clears the queue. Clicking a history item replays it.
- **Browser support.** It works on current desktop Chrome, Firefox, and Safari, plus mobile Safari and Chrome.

### Non-goals

The following are out of scope:

- Accounts or permissions inside the app. Everyone in a room can do everything. Restricting who can *start* rooms is left to a reverse proxy in front of `/start` (§5).
- Persisting room state across server restarts.
- Voting. (Room chat was added later, on request: §8.)
- Tight sync for multiple speakers in the same physical room.
- Transcoding. Only formats browsers play natively are supported, for uploads and for the server library alike. This is a deliberate scope decision, not an oversight.

---

## 2. Core architecture

The central decision is that **audio is never live-streamed through the server.** Each client plays the source independently, using an `<audio>` element for files and the YouTube IFrame player for YouTube.

The server holds only a shared *timeline*: which item is current, and where its playhead is as a function of server time. Each client continuously steers its local player to match that timeline.

This has three consequences:

- Late joiners just load the current item and seek to the right position.
- Server load is trivial: static file serving plus small JSON messages.
- A new source type only needs a way to produce a `mediaUrl` (or a new client-side `Player`). The queue and sync logic don't change. The server library (§10) relies on this: its tracks play through `FilePlayer` unchanged.

### Components

- **Server** (Node + TypeScript) handles room state, the WebSocket hub, the upload endpoint, media file serving, and YouTube metadata lookup.
- **Client** (a single-page app) handles the start page, the join flow, the room UI, clock sync, the sync engine, the player adapters, and drag-and-drop ingestion.
- **Shared package** holds all wire types, the timeline math, and YouTube URL parsing. It is the single source of truth for the protocol.

---

## 3. Tech stack and layout

- **Runtime.** Node 20.19+ (22 LTS recommended, see `.nvmrc`) with TypeScript in `strict` mode, organized as an npm workspaces monorepo.
- **Server.** Fastify, `@fastify/websocket`, `@fastify/static`, `music-metadata` (for tags, duration, and cover art), and `nanoid` (for item IDs).
- **Client.** Vite, Svelte 5, and TypeScript. Plain CSS with custom properties and no component library. Light and dark themes via `prefers-color-scheme`. Fonts: Fraunces (display) and Public Sans (UI), bundled via Fontsource.
- **Tests.** Vitest.
- **Dev setup.** Vite proxies `/api`, `/media`, `/ws`, and `POST /start` to the server.
- **Production setup.** The server serves the built client, so it runs as one process on one port.

```
/shared/src/protocol.ts              wire types + message unions
/shared/src/timeline.ts              position math and timing constants (used by server and client)
/shared/src/youtube.ts               YouTube URL parsing, embed-blocked message
/shared/src/audio.ts                 audio file extensions, titles from filenames
/server/src/index.ts                 bootstrap and signal handling
/server/src/app.ts                   routes, /start, static serving (buildApp, used by tests)
/server/src/config.ts                environment variables
/server/src/room.ts                  Room class: state + command handlers (unit-tested)
/server/src/rooms.ts                 room registry, lifecycle, idle cleanup
/server/src/roomNames.ts             readable room names (§5)
/server/src/validate.ts              parses and validates client messages
/server/src/ws.ts                    socket handling, broadcast
/server/src/media.ts                 uploads, media serving, metadata + art extraction, codec checks
/server/src/youtube.ts               oEmbed lookup
/server/src/library/source.ts        LibrarySource interface and the local-directory source (§10.2)
/server/src/library/library.ts       library index: scanning, cache, albums, art, queries (§10.3)
/server/src/library/search.ts        text normalization, matching, and ranking
/server/src/fixtures.ts              test fixtures: tagged WAV files built in memory
/client/src/lib/net/socket.ts        reconnecting WebSocket
/client/src/lib/sync/clock.ts        server clock offset estimation
/client/src/lib/sync/engine.ts       steers the active Player to the room timeline
/client/src/lib/players/Player.ts    interface
/client/src/lib/players/FilePlayer.ts
/client/src/lib/players/YouTubePlayer.ts
/client/src/lib/ingest/drop.ts       drag/drop, paste, pickers -> ingest requests
/client/src/lib/ingest/upload.ts     XHR uploads with progress
/client/src/lib/room.svelte.ts       RoomClient: reactive room state, commands, ingest
/client/src/lib/mediaSession.ts      lock-screen and media-key integration
/client/build/licenses.ts            Vite plugin writing third-party license notices
/client/src/components/...
```

Configuration comes from environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Port the server listens on. |
| `DATA_DIR` | `./data` | Directory for uploaded media, cover art, and (§10) the library index cache. |
| `MAX_UPLOAD_MB` | `300` | Maximum size of a single uploaded file. |
| `MAX_ROOM_MB` | `2048` | Maximum total size of the uploads one room holds (library tracks don't count). `0` means no limit. |
| `ROOM_IDLE_TTL_MIN` | `60` | Minutes an empty room survives before it and its files are deleted. |
| `CREATE_ROOM_ON_JOIN` | `true` | Whether opening a link to an unknown room creates it. Set to `false` when `/start` is behind authentication (§5). |
| `LIBRARY_DIR` | unset | Root of the server music library (§10). Unset disables the library. |
| `LIBRARY_RESCAN_MIN` | `360` | Minutes between incremental library rescans (§10). |
| `YOUTUBE_API_KEY` | unset | *(Planned, §14.)* YouTube Data API key. Unset disables YouTube search. |

---

## 4. Data model

```ts
type ItemKind = "file" | "youtube" | "library";
type ItemStatus = "uploading" | "ready" | "error";

interface QueueItem {
  id: string;             // nanoid(12)
  kind: ItemKind;
  status: ItemStatus;
  error?: string;

  // source
  mediaUrl?: string;      // file and library: /media/:roomId/:itemId
  youtubeId?: string;

  // metadata
  title: string;
  artist?: string;
  album?: string;
  discNo?: number;
  trackNo?: number;
  artUrl?: string;        // file and library: /media/:roomId/:itemId/art; youtube: thumbnail URL
  durationMs?: number;    // may be unknown until a client reports it

  addedBy: string;        // display name
  addedAt: number;        // server epoch ms
}

interface Playback {
  itemId: string;
  state: "playing" | "paused" | "waiting"; // waiting = current item is still uploading
  anchorPosMs: number;    // playhead position at anchorTime
  anchorTime: number;     // server epoch ms (may be slightly in the future, see §6.3)
}

interface Listener {
  clientId: string;
  name: string;
}

interface RoomSnapshot {
  roomId: string;
  rev: number;               // increments on every state change
  items: QueueItem[];
  currentIndex: number;      // 0..items.length; === items.length means idle
  playback: Playback | null; // null when idle
  listeners: Listener[];
}
```

The timeline math lives in `shared/timeline.ts` and is used by both the server and the client:

```ts
export function positionAt(pb: Playback, serverNow: number): number {
  if (pb.state !== "playing") return pb.anchorPosMs;
  return pb.anchorPosMs + (serverNow - pb.anchorTime);
}
```

The position can be negative when `anchorTime` is in the future. More generally, whenever `serverNow < anchorTime`, clients hold at `anchorPosMs` and start at the anchor instant (§6.3). For decisions such as pausing or `previous`, the server uses `effectivePositionAt`, which never reports less than `anchorPosMs` during the lead and never more than a known duration.

### Queue semantics: one list plus a pointer

- `items[0 .. currentIndex-1]` are **history**. They have already played and are shown dimmed.
- `items[currentIndex]` is the **current** item.
- Everything after the current item is **upcoming**.
- `currentIndex === items.length` means the room is **idle**, either because the room is new and empty or because the queue finished.
- History is never removed automatically. Items leave the list only through `remove` (one item), `clearPlayed` (all history), or `clear` (everything).
- **Jumping** to an earlier item just moves the pointer. Items after it become upcoming again and will replay. This is deliberate: the list is a playlist, and the pointer is where we are.
- **"Play next"** works on any item, including history, which is the "hear that one again" affordance. It moves the item to just after the current one without disturbing the pointer. From idle, it moves the item to the end and starts it.
- When the room is **idle and new items are added**, playback automatically starts at the first newly added item.
- Track changes (next, previous, jump, auto-advance) always start playing, even if the room was paused.

`currentIndex` must stay correct as the list changes. These rules live in `Room` and are unit-tested:

- Removing an item *before* the current one decrements `currentIndex`.
- Removing the *current* item starts the next item, or goes idle if there is none.
- Moving the current item keeps it current, and the pointer follows it.
- Moving a history item to after the current one decrements `currentIndex`.

---

## 5. Protocol

The WebSocket lives at `/ws/:roomId`. Messages are JSON objects of the form `{ type, ... }`.

**The server broadcasts a full `snapshot` on every state change.** Rooms are small, and full snapshots eliminate a whole class of diff bugs. Changes made while handling one command are coalesced into one snapshot. Clients render purely from the latest snapshot and ignore any snapshot whose `rev` is lower than the one they already have, except the first snapshot after each (re)connect, which always wins because a restarted server starts `rev` over.

### Client → server

| type | payload | effect |
|---|---|---|
| `hello` | `clientId, name` | Join the room. `clientId` is kept in `sessionStorage`, so a reconnect or reload counts as the same listener while two tabs in one browser are two listeners. This must be sent before any other command. |
| `ping` | `t0` | Clock sync. The server replies with `pong`. Allowed before `hello`. |
| `addYoutube` | `url, position: "end" \| "next"` | Parse the URL, look up metadata, and insert the item. |
| `addFiles` | `files: {tempId, title, artist?, album?, discNo?, trackNo?}[], position` | Create items with status `uploading`. The server replies with `filesAccepted`. |
| `addLibrary` | `trackIds: string[], position` | Add up to 500 server-library tracks as ready `library` items (§10.4). |
| `play` / `pause` | none | |
| `seek` | `positionMs` | |
| `next` | none | Advance to the next item. At the end of the list, go idle. |
| `previous` | none | If the position is more than 3000 ms, restart the current item. Otherwise go to the previous playable item, or restart if there is none. From idle, go to the last item. |
| `restart` | none | Seek to 0. |
| `jump` | `itemId` | Make that item current and start it at 0. Items in the `error` state can't be jumped to. |
| `playNext` | `itemId` | Move the item to just after the current one. |
| `move` | `itemId, toIndex` | Reorder. |
| `remove` | `itemId` | Remove one item. If it is still uploading, the uploader aborts its upload and the server discards the partial file. |
| `clear` | none | Remove all items and go idle. |
| `clearPlayed` | none | Remove the history (everything before the current item; everything, once the queue has finished). The current item keeps playing. |
| `chat` | `text` | Post a chat message (up to 500 characters, whitespace collapsed). Each connection may send bursts of 5, then one every 2 s; beyond that the server replies with an `error`. |
| `reportDuration` | `itemId, durationMs` | Accepted only if the item has no `durationMs` yet. |
| `ended` | `itemId` | The client's player finished the item. See §6.4. |
| `itemError` | `itemId, message` | The item itself can't be played (not a local network problem, §6.7). Mark it `error`, and skip it if it is current. |
| `status` | `driftMs, state` | Client sync health, sent roughly every 3 s. |

### Server → client

| type | payload |
|---|---|
| `snapshot` | `RoomSnapshot` |
| `pong` | `t0, serverTime` |
| `filesAccepted` | `{ ids: { [tempId]: itemId } }` |
| `activity` | `{ entries: {at, by, text, kind}[] }`: events (`kind: "event"`, for example "Maya skipped “Song”") and chat messages (`kind: "message"`). Live entries arrive one per message; the last 200 arrive in one message on join. Chat doesn't change room state, so it doesn't bump `rev`. |
| `presence` | Per-listener sync health. This is separate from `snapshot` so that frequent status updates don't bump `rev`. Throttled to once per second. |
| `error` | `message` |

The server closes a socket with code **4404** when `hello` names a room that doesn't exist and rooms aren't created on join. The client then stops reconnecting and shows "This room doesn't exist".

### HTTP endpoints

- **Room creation lives entirely under `/start`,** so a reverse proxy can put it behind authentication:
  - `GET /` redirects to `/start`.
  - `GET /start` serves the start page.
  - `POST /start` (the start page's form) creates a room and redirects (`303`) to `/r/:roomId`. It is a plain form navigation, not `fetch`, so an auth portal's login redirect works.
- `GET /api/rooms/:roomId` returns `200` if the room exists (or would be created on join) and `404` otherwise, so the room page can say "not found" before asking for a name.
- `PUT /api/rooms/:roomId/items/:itemId/file` accepts a raw-body upload, with `Content-Type` taken from the file. The server:
  1. Streams the body to disk.
  2. Parses it with `music-metadata`. The tags, duration, and codec from the server's parse override whatever the client guessed; client guesses remain where the file has no tags.
  3. Extracts any embedded cover to a separate file.
  4. Sets the item's status to `ready` and broadcasts.

  It rejects files over `MAX_UPLOAD_MB` and files with unsupported codecs (see §7). It also enforces two storage limits, since anyone with a room link can upload:
  - **Per room:** a room's uploads may total at most `MAX_ROOM_MB`. Bytes are counted as they stream in, so concurrent uploads can't overshoot. Space is returned when uploads are removed, fail, or turn out to be unplayable.
  - **Per server:** uploads are refused (`507`) while less than 512 MB of disk would remain free.
- `GET /media/:roomId/:itemId` serves the audio with correct Range support: `206 Partial Content`, `416` for unsatisfiable ranges, `Accept-Ranges`, and correct `Content-Length` and `Content-Type`. Safari is strict about this; it is covered by tests.
- `GET /media/:roomId/:itemId/art` serves the cover image.
- `GET /third-party-licenses.txt` serves the license notices for the client bundle (§13).
- The client's own routes are `/start` for the start page and `/r/:roomId` for a room. Any other path redirects to `/start` with a full navigation, so the proxy sees the request.

### Access control

Everything guests need stays public: `/r/*`, `/ws/*`, `/media/*`, `/api/*`, and `/assets/*`. Only `/start` needs protecting. With `CREATE_ROOM_ON_JOIN=true` (the default) anyone could create a room by opening `/r/<any-id>`, so a protected deployment must set it to `false`. For Caddy:

```caddyfile
app.example.com {
	@protected path /start /start/*

	handle @protected {
		route {
			authorize with mypolicy
			reverse_proxy app:3000
		}
	}

	handle {
		reverse_proxy app:3000
	}
}
```

### Room names

Room IDs look like `quiet-amber-otter-42`: a mood or quality, a color, material, or texture, a noun, and a two-digit number from 10 to 99, picked with `crypto.randomInt`. The word lists (193 × 136 × 189 words) give about 446 million combinations, roughly 29 bits.

The room name is the only thing keeping strangers out of a room, so the lists must not shrink much; a test enforces more than 400 million combinations. Words are lowercase a–z, no word appears in two lists, and words that could form unfortunate pairings (skin-tone colors, primates) are excluded on purpose. Any ID matching `^[A-Za-z0-9_-]{1,64}$` is still accepted, so older links keep working.

### Room lifecycle and storage

- **Unknown room IDs.** With `CREATE_ROOM_ON_JOIN=true`, joining an unknown room ID creates that room, which keeps shared links valid after a server restart, although the queue will be empty. With `false`, it closes with 4404 (see above).
- **Idle cleanup.** A room with no connected listeners for `ROOM_IDLE_TTL_MIN` minutes is deleted along with its files. On startup, the server deletes all room directories, since no room survives a restart.
- **File storage.** Never use user-supplied filenames on disk. Store media as `DATA_DIR/rooms/<roomId>/<itemId>.<ext>`.
- **Abandoned uploads.** If an uploader leaves and doesn't come back within 20 s, their items still waiting for uploads become errors, so a vanished uploader can't stall the room in `waiting`.
- **Validation.** The server validates every command (for example, that the item exists and the index is in range). Invalid commands get an `error` reply and never crash the server.

---

## 6. Synchronization

### 6.1 Clock sync

Take client time from `performance.timeOrigin + performance.now()`, because it is monotonic. `Date.now()` can jump when the system clock changes.

Compute the offset from ping/pong samples:

```
rtt    = t1 - t0
offset = serverTime + rtt/2 - t1
serverNow() = clientNow() + offset
```

- **On connect,** take 8 samples about 100 ms apart and use the offset from the sample with the lowest RTT.
- **Every 30 s,** take 3 more samples. Keep the offset from the lowest-RTT sample seen in the last 2 minutes.
- **On reconnect,** start over, since the client may have slept.

### 6.2 The server is authoritative

All transport commands go to the server. The server computes the new `Playback` state and broadcasts it. Clients never change their local player directly in response to their own button press. They wait for the snapshot, which keeps a single code path. The one exception is the seek bar, which may show an optimistic local preview while the user is dragging.

### 6.3 Start lead

When the server starts a track, resumes playback, or seeks during playback, it sets `anchorTime` slightly in the future (`now + LEAD`):

| Transition | New playback state |
|---|---|
| New track | `anchorPosMs = 0`, `anchorTime = now + 1000` (the extra time lets clients load the source) |
| Resume | `anchorPosMs = pausedPos`, `anchorTime = now + 300` |
| Seek while playing | `anchorPosMs = target`, `anchorTime = now + 300` |
| Seek while paused | `anchorPosMs = target`, stays paused |
| Pause | `anchorPosMs = positionAt(now)`, no lead |

The lead absorbs message delivery latency, so no client starts late by its own network delay. A client that receives the snapshot early holds its player at the anchor position, then starts it with a `setTimeout`, issued early by its learned start lead (§6.6). If the player is only slightly off the anchor position when holding (up to 250 ms, for example where a pause left it), it shifts the start time by the difference instead of seeking, because seeks can be slow. Only larger offsets seek.

### 6.4 Advancing tracks

The primary mechanism is a server timer:

- The server schedules a timer for when `positionAt` reaches `durationMs`, plus a 250 ms grace period.
- The timer is rescheduled on every playback change and cleared on pause.
- When it fires, the server advances to the next item, or goes idle if there is none.

Clients also send `ended` messages, which the server handles as follows:

- **If `durationMs` is unknown** (a YouTube item before any client has reported its duration, or a file whose metadata lacks one), the server relies on `ended`. It advances only if `ended.itemId` matches the current item. That check also dedupes: once the item changes, later `ended` messages for the old item are ignored.
- **If `durationMs` is known,** the server accepts `ended` only when the position is at least `durationMs - 2000`. This guards against a glitchy client skipping the track for everyone.

### 6.5 Waiting on uploads and skipping errors

- If the current item is still `uploading`, `playback.state` is `waiting` and the UI shows "Waiting for upload…".
- When the item becomes `ready`, the server starts it with the new-track lead.
- Items with status `error` are skipped automatically when the pointer reaches them.

### 6.6 Client sync engine

The engine runs a loop every 500 ms for files and every 1000 ms for YouTube, and also immediately on every new snapshot. On each tick:

1. Compute `expected = positionAt(playback, serverNow())`.
2. If the active player doesn't have the current item loaded, load it (swapping player type if needed).
3. If the state is `paused` or `waiting`, make sure the player is paused. Seek to `anchorPosMs` if it is off by more than 250 ms.
4. If the state is `playing` but `serverNow < anchorTime`, hold and schedule the start (§6.3).
5. Near the end of the item (within 250 ms of a known duration), or once the player has ended, leave it alone; the server advances the room. An ended `<audio>` element must never get `play()` again, because that restarts it from 0.
6. Skip corrections while the player is buffering, and for a 1.5 s cooldown after any seek, to avoid seek storms.
7. Otherwise compute `drift = actual - expected` and correct it according to the player's **correction mode**:
   - **Rate nudging** (files, default):
     - If `|drift| <= 40 ms`, set the rate to 1.0.
     - If `|drift|` is between 40 and 750 ms, set `rate = clamp(1 - drift/4000, 0.95, 1.05)`. Pitch is preserved through `preservesPitch`.
     - If `|drift| > 750 ms`, hard-seek.
   - **Seek only** (files on WebKit, §6.8): never change the rate. Hard-seek when `|drift| > 150 ms` for two ticks in a row, so one noisy reading doesn't cause a seek.
   - **YouTube:** only seek. Its playback rates are too coarse for nudging, so hard-seek when `|drift| > 600 ms`.
   - In all cases, make sure the player is playing.
8. Send a `{ driftMs, state }` status report to the server every ~3 s.

**Learned leads.** Two per-player values adapt to how slow this client's player is:

- **Seek lead.** A hard seek aims at `expected + seekLead`. After each hard seek, the first clean measurement adjusts it by where the seek landed: `seekLead = clamp(seekLead - drift, 0, 3000)`. Without this, a player whose seeks take longer than the hard-seek threshold lands behind by more than the threshold every time and seeks forever (§6.8).
- **Start lead.** Scheduled starts call `play()` this much before the anchor instant, and it is learned the same way (clamped to 0–2000 ms). It is learned only from plain starts where the lead fit inside the warning the room gave (1 s for new tracks, 300 ms for resumes) and no seek was needed while holding. Otherwise the measurement would mix in seek time or reflect an unavoidable late start, and the lead would creep upward.

**A buffering client does not pause the room.** It catches up on its own once it recovers.

Volume and mute are local to each client and are never synced. Persist them in `localStorage`. On iOS, `volume` is read-only, so muting goes through `muted`.

### 6.7 Player interface

```ts
interface Player {
  readonly kind: ItemKind;
  load(item: QueueItem): Promise<void>;   // resolves when ready to play
  play(): Promise<void>;
  pause(): void;
  seek(ms: number): void;
  positionMs(): number;
  setRate(rate: number): void;            // no-op for YouTube
  setVolume(v: number): void;             // 0..1
  isBuffering(): boolean;
  isPaused(): boolean;
  isEnded(): boolean;                     // never play() an ended <audio>: it restarts from 0
  onEnded(cb: () => void): void;
  onError(cb: (message: string, recoverable: boolean) => void): void;
  onDuration(cb: (ms: number) => void): void;
  destroy(): void;
}
```

**Recoverable errors.** A failure local to one client must not skip a track for the whole room. Players classify errors:

- Media errors 1 (aborted) and 2 (network) are recoverable.
- Browsers report an *unreachable* source as error 4 ("format not supported"). So for format and decode errors (3 and 4), `FilePlayer` probes the media URL with a `HEAD` request. If that fails or returns a 5xx, the error is recoverable; if the file is reachable, the item really is unplayable.

Recoverable errors make the engine drop the loaded item and reload it after 2 s. Only non-recoverable errors send `itemError`. Note that a file one browser can't decode (say, a codec Firefox lacks) is still marked `error` for everyone, as §5 specifies.

**FilePlayer** uses two `HTMLAudioElement`s: one active, one preloading the next upcoming file item. They swap roles at each track change, so transitions are quick.

On iOS, an audio element only plays programmatically if it was first played inside a user gesture. So, during the Join click, call `play()` and then `pause()` on **both** elements, with a tiny silent data-URI source. Reuse those two elements for the rest of the session rather than creating new ones.

**YouTubePlayer** uses the IFrame Player API. Load `https://www.youtube.com/iframe_api` once.

- **Player settings.** Use `playerVars: { controls: 0, disablekb: 1, rel: 0, playsinline: 1 }` and set `origin`.
- **Readiness.** The object returned by `new YT.Player` has no methods until `onReady` fires. Every call before then must wait.
- **Seeking before start.** `seekTo` on an unstarted or cued video starts playback, so seeks in those states are deferred until `play()`.
- **Visibility.** The video must remain visible, because YouTube's terms require a player of at least 200×200 px. It renders in the now-playing art area. Do not overlay anything on top of it.
- **Local interaction.** If a user interacts with the embed directly (for example, clicking it pauses the video), the sync engine simply re-applies the room state on its next tick.
- **Duration.** Report the duration via `getDuration()` once it is greater than 0.
- **Errors.** Error codes 101 and 150 (embedding disabled) and 100 (removed or private) trigger `itemError`. Treat any other error code the same way.
- **Ads.** Ads may play on some clients. The seek threshold and cooldown keep the engine from thrashing during an ad, and it resyncs once the ad ends.
- **Known risk on iOS.** The embed sometimes needs a first tap on the video itself before programmatic play works. If `playVideo()` doesn't take effect within 2.5 s, show a "Tap the video to start" hint.

### 6.8 Safari and WebKit

Chrome and Firefox (tested with Vivaldi and Zen) sync within a few milliseconds using rate nudging. Safari needed three changes, found by testing on macOS and iOS. The behavior was confirmed on real devices, and simulated players in `engine.test.ts` reproduce each problem.

1. **Slow seeks caused a seek loop.** Safari can take more than a second for a seek to become audible, probably because it fetches a new byte range instead of using buffered audio; Chrome buffers the whole file, so its seeks are nearly instant. A hard seek aimed at where the room is *now* landed more than 750 ms behind, which triggered another hard seek after the cooldown, forever. It sounded like audio playing briefly, going silent, and repeating every ~1.5 s. **Fix:** the learned seek lead (§6.6). A simulated player with 1 s seeks went from ~40 seeks a minute to 2.
2. **Changing `playbackRate` during playback glitched.** Safari caught up correctly at the capped 1.05×, but as soon as the rate began changing every tick (around −180 ms drift, where `1 - drift/4000` drops below the cap), playback jumped and triggered a reseek. **Fix:** WebKit uses seek-only correction (§6.6). Detection: any iOS browser (all iOS browsers use WebKit, including iPadOS reporting as a Mac with touch), or a user agent containing `Safari/` but not `Chrome/`, `Chromium/`, `Edg/`, `OPR/`, or `Firefox/`. `?sync=rate` or `?sync=seek` in the room URL overrides the choice for testing.
3. **Safari starts late.** `play()` took about 900 ms to become audible, so every track started ~900 ms behind and then crawled back. **Fix:** the learned start lead (§6.6), which fits inside a new track's 1 s warning. A resume only gives 300 ms of warning, so on Safari a resume can still land late and take one correction seek.

Do not reintroduce rate nudging for WebKit without retesting on Safari. When diagnosing sync, the debug panel's action log (§8) shows the exact sequence of loads, starts, seeks, and rate changes.

---

## 7. Ingestion

### Entry points

All entry points feed a single ingest function:

- **Drag and drop** anywhere on the room page. While something is being dragged, a full-window overlay says "Drop to add to the queue."
- **Paste** (Ctrl/Cmd+V) anywhere outside a text field. A pasted YouTube URL gets added; pasted files are ingested.
- **Add controls:**
  - a text input for pasting a link (to become the search box, §10.5)
  - a multi-select file picker
  - a folder picker (`webkitdirectory`), where supported; on iOS, it is hidden and the multi-select picker remains.

  The pickers are required, because mobile browsers have no drag-and-drop.

### Links

- Read `text/uri-list` first, then `text/plain`.
- Recognize YouTube URLs in these forms: `watch?v=`, `youtu.be/`, `/shorts/`, `/embed/`, `/live/`, `youtube-nocookie.com`, and `music.youtube.com`.
- Ignore playlist parameters for now. (**Stretch:** expand playlists.)
- For non-YouTube URLs, show an error toast saying only YouTube links are supported.
- The server fetches metadata (title, channel, thumbnail) from `https://www.youtube.com/oembed?url=<url>&format=json`. This needs no API key. The duration comes from the first client's `reportDuration`.
  - `401` or `403` means embedding is disabled: the item is added already marked `error` with the embed-blocked message, so it is skipped.
  - `400` or `404` means the video doesn't exist or is private: the link is rejected.
  - If YouTube is unreachable, the item is added with a generic title and thumbnail.
- **Embed-blocked message:** "The owner doesn't allow this video on other sites. Try a different upload, such as a lyric video." Official music uploads are the usual cause; label and distributor restrictions block embedding while ordinary videos embed fine.

### Files and folders

- **Grab entries synchronously.** In the drop handler, call `DataTransferItem.webkitGetAsEntry()` on every item *synchronously*, before any `await`, because the `DataTransfer` is invalidated after the event. The entries themselves stay usable afterward.
- **Walk directories recursively.** `readEntries()` returns results in batches, so keep calling it until it returns an empty array. Otherwise large folders get silently truncated.
- **Filter by extension.** Accept `mp3`, `m4a`, `aac`, `flac`, `ogg`, `oga`, `opus`, `wav`, and `webm`. Skip everything else quietly (for example `cover.jpg`, `.cue`, `.log`) and summarize the result, such as "Added 12 tracks, skipped 3 non-audio files."
- **Read tags client-side** with `music-metadata`'s browser-compatible `parseBlob` (with `skipCovers: true`). This way the queue shows real titles immediately and the ordering is right.
- **Sort each dropped batch** by directory path, then disc number, then track number, then a natural filename sort.
- **Upload.** Send `addFiles`, receive the item IDs, and upload with `XMLHttpRequest`, because `fetch` has no upload progress events. Use a concurrency of 2, in queue order, so the earliest tracks become playable first.
- **Show progress.** The uploader sees a percentage for each item. Everyone else sees "uploading…".

### Codec support

The server checks `format.codec` and the container from `music-metadata`. It marks formats that browsers can't play natively as `error`, with a clear message. The notable cases are **ALAC inside .m4a**, **WMA**, non-PCM WAV encodings (PCM, IEEE float, and `WAVE_FORMAT_EXTENSIBLE` are accepted), Speex, and containers like APE, WavPack, and AIFF. The same check decides which files the server library indexes (§10.2). Transcoding is out of scope (§1).

---

## 8. UI

On wide screens (900 px and up), the room page uses two columns: now playing on the left and the add controls, queue, and activity feed on the right. On narrow screens the sections stack.

### Start page and join overlay

- **Start page** (`/start`): a short description and a **Start a session** button, which submits the form described in §5.
- **Join overlay:** appears on every room entry. It has a display-name input, prefilled from `localStorage`, and a **Join and listen** button. That click is the user gesture that unlocks audio under browser autoplay policies, so nothing may try to play before it.
- **Missing room:** if the room doesn't exist (`GET /api/rooms/:roomId` returns `404`, or the socket closes with 4404), show "This room doesn't exist" with a **Start a new session** link instead of the join overlay.

### Header

- **Room identity.** The room name.
- **Copy link.** A button that copies the room URL. `navigator.clipboard` needs HTTPS or localhost, so fall back to showing the URL selected in a text field.
- **Listeners.** A list of names, each with a sync-health dot:
  - green: within 100 ms
  - yellow: within 500 ms
  - red: worse than 500 ms, or buffering

### Now playing

- **Art.** A large area showing the embedded cover for files or the video for YouTube items. When there is no art, show a generated placeholder derived from the title. The art is sized so the transport controls stay visible on short screens.
- **Details.** Title, artist, album, "Added by X", and a small source indicator (file, YouTube, or library). YouTube items also show a **Watch on YouTube** link, opening in a new tab.
- **Progress bar.** Shows elapsed and total time as m:ss.
  - The displayed position comes from the **room timeline**, not from the local player, so every client's bar agrees.
  - The bar is scrubbable by pointer and keyboard. While dragging, show a local preview, and send `seek` only on release. Repeated key presses are coalesced into one seek.
- **Transport.** Previous, Play/Pause, Next, and Restart.
- **Volume.** A local volume slider and mute button.
- **States.**
  - idle, empty queue: "The queue is empty. Drop some music here or paste a YouTube link."
  - idle, queue finished: "The queue finished. Pick a track to hear it again, or add more."
  - waiting: "Waiting for upload…"
  - error: the item is skipped; the error shows on its queue row and in the activity feed.

### Queue panel

- **Layout.** One list with three parts: history (dimmed, with a divider between played and upcoming), the current item (highlighted, with a small animated playing indicator), and upcoming items. When the queue has finished, an "End of queue" marker follows the history.
- **Played tracks fold away.** A "Played · N tracks" row sits above the current item; history is collapsed by default, so a long session doesn't push the upcoming tracks far down, and each viewer's choice is remembered in their browser. The row also has **Clear played** (with a confirmation step), which removes the history for everyone.
- **Rows.** Each row shows small art, title, artist, duration, who added it, and its status (upload percentage or error message). Error messages are clamped to two lines, with the full text on hover.
- **Interaction.** Clicking a row jumps to that item. Each row also has a `⋯` menu with **Play next** and **Remove**; YouTube items add **Open on YouTube** and **Copy link** (with a clipboard fallback for plain-HTTP LAN installs).
- **Reordering.** Upcoming items can be dragged to reorder them, using pointer events so it works on touch screens, or moved with the arrow keys on a focused drag handle.
- **Footer.** Shows the item count and total remaining time, plus a **Clear queue** button with a confirmation step.

### Other UI

- **Chat.** A collapsible panel mixing room events ("Maya added 11 tracks from “Album”", shown quietly) with chat messages, oldest first, and a message box at the bottom. It follows new entries unless you've scrolled up to read, and shows an unread count while collapsed. Links (http, https, and www. only) are clickable, and YouTube links get an **Add to queue** button, since sharing music is the point. Errors appear as toasts.
- **Keyboard shortcuts.** These are ignored while focus is in a text field, and Space is left to a focused button or control.

  | Key | Action |
  |---|---|
  | Space | play/pause |
  | ← / → | seek back / forward 10 s |
  | Shift+← / Shift+→ | previous / next |
  | M | mute |
  | D | toggle the debug panel |

- **Debug panel.** Opened with D, or with `?debug` in the room URL (for phones). Shows the clock offset, best RTT, current drift, playback rate, correction mode, seek lead, start lead, player state, position, snapshot `rev`, and the last eight engine actions with timestamps and drift. This is essential for verifying sync.
- **Media Session API** (file and library items). Set the metadata (title, artist, album, artwork) and call `setPositionState`. Register handlers for play, pause, next, previous, and seek that send the matching room commands. This makes lock-screen controls and hardware media keys work. YouTube's embed manages its own session.
- **Tab title.** Set `document.title` to "▶ Title – Artist" while something is playing.

### Visual direction

Make the now-playing art the one bold element, and keep everything around it quiet and disciplined: warm paper neutrals, one ember accent, a serif (Fraunces) for titles.

Meet this quality floor: visible keyboard focus, `prefers-reduced-motion` respected, good contrast in both themes, and comfortable touch targets.

Write interface copy in plain, sentence-case language. Buttons name exactly what they do.

---

## 9. Resilience

- **Reconnection.** The WebSocket reconnects with exponential backoff, from 0.5 s up to a maximum of 10 s, and immediately when the browser reports it is back online. On reconnect, the client re-sends `hello` with the same `clientId`, redoes clock sync, and renders the new snapshot.
- **Playback while disconnected.** Show a "Reconnecting…" banner, but keep local playback running from the last known timeline.
- **Local failures.** A client's network failures are retried locally and never mark an item as broken for the room (§6.7).
- **Removed uploads.** If an item that is still uploading disappears from the snapshot (because someone removed it or cleared the queue), abort its XHR.
- **Dead connections.** The server pings sockets every 30 s and drops ones that don't answer, so the listener list stays accurate.
- **Bad input.** The server never crashes on invalid input (see §5).

---

## 10. Server library (next milestone)

Listeners can search a music library on the server's disk from the room page, by song, album, or artist, and add a song or a whole album to the queue.

### 10.1 Decisions

- **Reference, don't copy.** Adding a library track creates a `library` item whose media record *points to* the library file. Clients fetch it through the existing room-scoped `/media/:roomId/:itemId` URL, exactly like an upload. So:
  - there is no library URL and no path in any request; clients only ever send track IDs;
  - only tracks added to a live room can be fetched;
  - adding a track is instant and uses no extra disk, even for a FLAC album;
  - removing the item or expiring the room forgets the link. The library file itself is never modified or deleted.

  The trade-off: if a library file is edited or deleted while in a queue, that item fails to play (see 10.4). Copying into the room would avoid that at the cost of time and disk; reference was chosen.
- **What this protects.** Nothing in the library is reachable without a room link, and every addition shows in the queue and activity feed. It does not restrict what a room's guests can find and play: anyone with a room link can search the whole library and add any track. That is accepted for now.
- **Browser-playable formats only.** The library indexes only files that pass the upload codec check (§7). Unplayable files are counted in the server log and never appear in search. No transcoding (§1).
- **Size.** Designed for about 5,000–10,000 tracks. An in-memory index and search is instant at that size; SQLite full-text search is the upgrade path if a library grows past a few hundred thousand tracks.

### 10.2 Library sources

The first source is a local directory: `LIBRARY_DIR`, typically a read-only Docker bind mount. Later sources may be a NAS mount (same code, slower) or a WebDAV(S) server holding the files. To keep that possible, everything that touches files goes through a source interface, and nothing else assumes a local path:

```ts
interface LibraryFile {
  path: string;       // relative to the source root, "/"-separated
  size: number;
  version: string;    // local: mtime; WebDAV: ETag or last-modified
}

interface LibrarySource {
  /** Every candidate audio file (filtered by extension). */
  list(): AsyncIterable<LibraryFile>;
  /** Tags, duration, and codec, reading only what the parser needs. */
  readMetadata(file: LibraryFile, options: { covers: boolean }): Promise<IAudioMetadata>;
  /** Current size and version, or null if the file is gone (checked when serving). */
  stat(path: string): Promise<{ size: number; version: string } | null>;
  /** A byte range of the file (inclusive), for serving with Range support. */
  open(path: string, range?: { start: number; end: number }): Promise<Readable>;
  /** Folder images (cover.jpg, folder.jpg, ...) next to a file, if any. */
  folderArt(path: string): Promise<{ read(): Promise<Buffer>; mime: string } | null>;
}
```

- **Local directory.** `list` walks the tree (skipping hidden files); `readMetadata` uses `music-metadata`'s `parseFile`; `open` uses `fs.createReadStream` with a range. Resolve real paths and reject anything, including symlink targets and folder images, outside the root. A file reachable both directly and through a symlink is indexed once, under its real path.
- **WebDAV (future).** `list` uses `PROPFIND` (walking directories, since `Depth: infinity` is often disabled); `readMetadata` parses through a tokenizer that issues HTTP Range requests, so scanning reads only headers, not whole files; `open` proxies the file to the client with Range passed through. The media route then streams from the source rather than from a local path. Scans will be much slower, which the incremental cache (10.3) absorbs.

### 10.3 Index

- **Track record:**

  ```ts
  interface LibraryTrack {
    id: string;          // stable hash of the relative path; survives rescans
    path: string;        // relative path; never sent to clients
    size: number;
    version: string;
    title: string;       // falls back to the filename
    artist?: string;
    albumArtist?: string;
    album?: string;
    discNo?: number;
    trackNo?: number;
    year?: number;
    durationMs?: number;
    mime: string;        // from the codec check
    albumId?: string;    // see below
  }
  ```

- **Albums** group tracks by album title within one folder, so two different albums called "Greatest Hits" stay separate. The album ID is a hash of those. Album tracks are ordered by disc, then track number, then filename.
  - **Multi-disc sets:** a trailing disc marker in the album tag ("Moonmadness - CD 1", "The Anthology, CD2", "Stars Die (Disc 2)") is removed from the title and becomes the disc number when there's no disc tag. A folder named for one disc ("CD2", "Disc 1", "666 - CD 2") counts as its parent folder. So each set is one album, in disc order. A marker in the middle of a title ("… - CD 3 - Supernova") is left alone: those discs have their own names.
  - **The album artist** is the album-artist tag, else the one artist on every track, else "Various Artists".
- **Files without an album tag** take their album from their folder's name, with years ("(1971)", "1995 -"), bracketed notes ("[MP3 192kbps]", "{1996 Castle Remaster}"), and a leading "Artist - " (the artist tag, or the parent folder's name) removed: "(1971) Distortions [MP3 192kbps]" becomes "Distortions". Disc folders count as their parent. Tracks at the top level, loose in the artist's own folder, or in placeholder folders ("Unknown Album") get no album.
- **Untagged files** take their title from the filename. A leading track number is used as the track number when a separator or a leading zero marks it ("01 - diodo.mp3", "01. Intro", "1-04 Song"); otherwise it stays part of the title ("99 Luftballons", "7 Streets"). Uploads use the same rule.
- **Album art** is extracted once per album during the scan into `DATA_DIR/library-art/<albumId>.<ext>`: the embedded cover of one of the first three tracks, else a folder image. Folder images are chosen from the album's folder (and the set's folder, for a disc folder), preferring names with "front", "cover", or "folder", then Windows album art, then a lone image. Backs, inlays, booklets, disc scans, and thumbnails are skipped. `Artwork/`, `Covers/`, and `Scans/` subfolders count only for images named as the front. JPEG, PNG, WebP, GIF, and BMP are accepted. Art files nothing refers to are deleted after each scan.
- **The cache** carries a format version; indexing changes that alter what's stored bump it, and an older cache triggers one full rescan.
- **Scanning** runs in the background at startup and every `LIBRARY_RESCAN_MIN` minutes, parsing about 4 files at a time. It is incremental: the index is cached in `DATA_DIR/library-index.json`, and a file is re-read only if its `size` or `version` changed. Unplayable and unreadable files are remembered in the cache too, so they aren't re-read every scan. Files that disappeared are dropped. Measured with 10,000 generated tracks: a full scan in about 3 s, a no-change rescan in 0.6 s, the cache loaded in 11 ms, and searches in 2–6 ms. On a real 5,382-track library (MP3, FLAC, and AAC on local disk): a full scan in 66–72 s, a no-change rescan in 0.3 s, and a restart from cache plus first search in 61 ms. It indexed every file, grouped them into 562 albums, and found art for 62% of them. Folder watching isn't used, because it's unreliable on Docker mounts and network shares. While the first scan runs, search works on what is indexed so far and reports that indexing is in progress.
- **Artist tags:** `music-metadata` splits ID3v2.3 artists on "/", reading "AC/DC" as "AC". The app rejoins the artist list with "/" (for uploads too), which restores the tag as written.
- **Search** is in memory:
  - Normalize text by case-folding and stripping accents (NFKD, remove combining marks). Apostrophes join words rather than splitting them ("B'Day" is "bday"), and each field also matches as one run-together word, so "acdc" finds "AC/DC".
  - Every query word must prefix-match a word in the track's title, artist, album artist, or album.
  - Rank exact matches over prefix matches, and title and name matches over the rest.
  - Return up to 10 artists, 20 albums, and 50 songs.

### 10.4 Server behavior

- **Endpoints,** all room-scoped. Each returns `404` unless the room exists, and all are disabled when `LIBRARY_DIR` is unset:
  - `GET /api/rooms/:roomId/library` → `{ enabled, indexing, trackCount }`
  - `GET /api/rooms/:roomId/library/search?q=` → `{ artists, albums, tracks }`, with `q` up to 200 characters
  - `GET /api/rooms/:roomId/library/albums/:albumId` → the album and its ordered tracks
  - `GET /api/rooms/:roomId/library/artist?name=` → the artist's albums and tracks (a query parameter, so names like "AC/DC" survive intact)
  - `GET /api/rooms/:roomId/library/albums/:albumId/art` → album art for search results

  Responses carry track IDs and metadata only, never paths.
- **`addLibrary { trackIds, position }`**, with up to 500 IDs. Unknown IDs are errors. The server creates one `library` item per track:
  - status `ready`, with no upload and no `waiting` state;
  - `mediaUrl` of `/media/:roomId/:itemId`, like an upload;
  - title, artist, album, disc and track numbers, and duration filled in from the index;
  - `artUrl` of `/media/:roomId/:itemId/art`.

  The activity feed reads "added 12 tracks from “Album”", as for uploads.
- **Media records** gain a notion of ownership. Uploaded files are *owned* by the room and deleted with it; library files and cached album art are *referenced* and must never be deleted by room cleanup or item removal. Serving uses the same Range logic (§5), reading through the source.
- **Missing files.** If a referenced file can't be opened when served, respond `404` and mark the item `error` with "This file is no longer in the library." The client's reachability probe (§6.7) then treats it as a real error rather than a local network problem.

### 10.5 UI

- **One search box** replaces "Paste a YouTube link". Text that looks like a link (a YouTube URL, or anything starting with `http(s)://` or `www.`) is added on Enter or with an **Add video** button; anything else is a search. Escape clears it. Without a library, the box is the plain link field it was before.
- **Tabs:** **Library**, shown when the library is enabled, and later **YouTube** (§14), each shown only when configured. Library searches as you type (debounced ~150 ms); YouTube searches on Enter to protect its quota.
- **Library results** are grouped into Artists, Albums, and Songs, in a panel that scrolls on its own (up to 60% of the viewport) so the queue stays reachable:
  - songs and albums each have **Add** and **Play next**, confirmed with a short toast;
  - albums expand to show their tracks (each addable), and adding an album adds its tracks in order;
  - artists open a view of their albums and songs, with a back button;
  - long lists show the first 6 albums and 8 songs, with **Show all**.
- **While indexing,** show "Indexing library… (N tracks so far)".
- **Library items** show "Library" as their source in now playing and the queue.

### 10.6 Deployment

```yaml
services:
  relayer:
    environment:
      LIBRARY_DIR: /music
    volumes:
      - media:/data
      - /srv/music:/music:ro
```

### 10.8 Library report

`server/src/tools/libraryReport.ts` (`npm run library-report`, or `node server/dist/tools/libraryReport.js` in the image) writes a Markdown report of problems the library works around but that are better fixed in the files. The report logic is `server/src/library/report.ts`. Sections appear only when they have something in them:

- files the app can't play (APE, WMA, AIFF, WavPack, and similar);
- duplicate copies of a track within an album;
- folders whose tracks split into several albums (album tag typos, stray files);
- the same artist and album in several folders;
- box sets that name each disc;
- files without album, title, or artist tags, as the files are actually tagged, with the album the app infers;
- album tracks without a track number;
- artist names that differ only in capitals, accents, punctuation, "&", a leading "The", or a "feat." credit;
- albums without art, separating those whose folder holds images the app couldn't identify as the front cover.

It reads the library only, and indexes into a temporary folder rather than the server's cache, so it's safe to run alongside the server.

### 10.9 Tests

- **Scanner:** use generated, tagged audio fixtures in a temporary directory. Check playable-only indexing, the incremental rescan (unchanged files not re-read; changed and removed files handled), stable IDs, album grouping, and that symlinks escaping the root are rejected.
- **Search:** ranking, accent and case folding, multi-word prefix matching, and result limits.
- **Endpoints and `addLibrary`:** room scoping (`404` without a room), no paths in responses, ready items with metadata, album ordering, Range serving through the room URL, the missing-file behavior, and that item removal and room cleanup never delete library files.

---

## 11. Testing

### Unit tests (Vitest)

Cover the `Room` command handlers thoroughly. Test the effect of each command on `items`, `currentIndex`, and `playback`, especially these cases:

- `remove` and `move` around the current item
- both branches of `previous`
- jumping backward
- `playNext` on a history item
- `clear`
- auto-start when items are added while the room is idle
- advancing past the last item into idle
- `waiting` on an item that is still uploading
- skipping items in the `error` state
- the dedupe and position guard on `ended`

Also test:

- `positionAt`
- the clock offset estimator, using synthetic samples with asymmetric delays
- the YouTube URL parser, with table-driven cases
- the sort order for dropped batches
- the upload pipeline and Range serving (`media.test.ts`)
- the WebSocket protocol, `/start`, room lookups, and 4404 handling
- room names: format, word lists, and combination count
- **the sync engine**, against simulated players with configurable seek latency, start latency, jitter, and dropouts on rate changes (§6.8). The engine must settle after a few seeks, never loop, learn its leads without over-learning, and never change the rate in seek-only mode.

### Manual acceptance checklist

- [x] With two browser windows side by side, drop an album folder into one. The tracks appear in both windows in the correct order, playback starts, and the audio is audibly in sync, with no echo.
- [x] Seek, pause, resume, next, previous (both branches), and restart work from either window, and both windows follow.
- [x] A third client that joins mid-song starts at the correct position.
- [ ] If one client's network is throttled to "Slow 3G" in DevTools, it buffers and lags while the room keeps playing, then catches up once the throttle is removed.
- [x] If a client's network drops briefly, it reconnects and resyncs.
- [x] A YouTube link works via paste, via drag from another tab, and via the input box, and it plays in sync within ~0.5 s. A video with embedding disabled is marked as an error and skipped.
- [x] Played tracks remain listed as history, and clicking one replays it. **Clear queue** empties the list and stops playback.
- [ ] On mobile Safari, joining and playback work, lock-screen controls work, and the file picker works.
- [x] On a LAN, the debug panel shows drift typically under 50 ms for file items.
- [x] Safari, a Firefox-based browser, and a Chromium-based browser on three machines play audibly in sync.

---

## 12. Build order

Build in these milestones. Commit after each one with tests passing.

1. **Skeleton.** *(Done.)* Workspaces, shared types, the server room registry, the WebSocket with snapshot broadcasting, the landing page, the join flow, and the listener list.
2. **Synchronized file playback.** *(Done.)* Clock sync, the upload pipeline, `FilePlayer`, the sync engine, now playing, transport controls, the seek bar, and the debug panel.
3. **Queue.** *(Done.)* History, current, and upcoming rendering; jump, play next, reorder, remove, and clear; folder drops with sorting; and the file pickers.
4. **YouTube.** *(Done.)* URL parsing, the oEmbed lookup, `YouTubePlayer`, duration reporting, and error handling.
5. **Polish.** *(Done.)* The activity feed, Media Session, keyboard shortcuts, the reconnect banner, idle room cleanup, codec rejection messages, and the responsive layout.
6. **Library: index.** *(Done.)* The `LibrarySource` interface and local-directory source, the scanner with the incremental cache and album art, and in-memory search, all unit-tested.
7. **Library: rooms.** *(Done.)* The room-scoped endpoints, `addLibrary`, referenced media records and serving, and missing-file handling.
8. **Library: search UI.** *(Done.)* The unified search box, the Library tab, grouped results, album expansion, and the indexing state.
9. **YouTube search** (§14), once a YouTube Data API key is available.

Don't add features beyond this spec without asking first.

---

## 13. Deployment notes

- **Build and run.** `npm run build && npm start` runs everything as a single process.
- **Docker.** A multi-stage `Dockerfile` on `node:22-alpine`:
  - The final image holds the compiled app plus only the server's production dependencies, copying the whole install tree, because npm nests some packages under a workspace.
  - It runs as the non-root `node` user, with a healthcheck on `/` and a `/data` volume for uploads.
  - `compose.yaml` builds the image locally as `relayer:local`. After release, it will pull a published image from GHCR instead.
- **Reverse proxy.** Behind a proxy, forward WebSocket upgrades (Caddy's `reverse_proxy` does this by default). For nginx:

  ```nginx
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  ```

  Also raise the proxy's upload limit, for example with `client_max_body_size`. To restrict who can start rooms, see §5.
- **HTTPS.** HTTPS is recommended, because the clipboard API and some mobile browser behaviors depend on it.
- **License.** MIT. The client build writes the licenses of every bundled third-party package, including the OFL-licensed fonts, to `third-party-licenses.txt`. The server's dependencies keep their own license files in the image. YouTube's terms of service apply to anyone running the app, since it embeds YouTube's player.

---

## 14. YouTube search (planned)

Search YouTube from the same search box, in a YouTube tab, and add results like pasted links.

- **API.** The official YouTube Data API v3, called from the server so the `YOUTUBE_API_KEY` stays secret. When the key is unset, the tab is hidden.
- **Search.** `search.list` with `type=video`, `videoEmbeddable=true` (the uploader allows embedding), `videoSyndicated=true` (playable outside youtube.com), and `maxResults` of about 15.
- **Details.** One `videos.list` call for the result IDs (up to 50 per call) with `part=contentDetails,status,snippet`. This gives:
  - the ISO 8601 duration, so YouTube items no longer wait for a player to report it;
  - `status.embeddable`;
  - `contentDetails.contentRating.ytRating === "ytAgeRestricted"` (age-restricted videos can't play in embeds, so drop them);
  - `contentDetails.regionRestriction` (label restricted videos).
- **Embeddability is best-effort.** YouTube documents that embeddable videos "may still be blocked from playback in embedded players due to platform policies or third-party claims", which is typical of official music uploads. The existing runtime handling (error 101/150 → `itemError` with the embed-blocked message) stays.
- **Quota.** The default is 100 `search.list` calls per day per Google Cloud project, plus 10,000 units per day for other calls, where `videos.list` costs 1 unit. So:
  - YouTube search runs on Enter, not as you type;
  - identical queries are cached for about 10 minutes;
  - a clear message shows when the daily quota runs out.

  More quota can be requested from Google.
- **Not used:** keyless scraping (Invidious or Piped instances, yt-dlp's search, YouTube's internal API). It costs no quota, but it breaks without warning and violates YouTube's terms.

---

## Stretch list

- Persist room snapshots to `DATA_DIR`, and reload them on startup.
- Expand YouTube playlists into individual items.
- Transcode unsupported codecs (ALAC, WMA) with ffmpeg. Currently out of scope by decision (§1).
- Dedupe uploads by content hash.
- Library sources for a NAS mount and WebDAV(S) (§10.2).
- Restrict library search to authenticated users (it is available to all room guests for now, §10.1).
- A link to the third-party license notices from the UI.
- Publish images to GHCR.
- Add optional host-only controls for a room.
