# Listening Room

A small self-hosted web app for listening together. Start a room, share the
link, and everyone who opens it hears the same thing at the same moment. Add
audio files, whole album folders, or YouTube links to a shared queue.

Audio is never streamed through the server: each browser plays the source
itself, and a sync engine steers it to a shared timeline. 

## Requirements

Node 20.19+ (22 LTS recommended; see `.nvmrc`).

## Development

```sh
npm install
npm run dev      # server on :3000, Vite dev server on :5173 (proxies /api, /media, /ws)
npm test         # Vitest
npm run check    # TypeScript + svelte-check
```

Press **D** in a room to open the sync debug panel, or add `?debug` to the room
URL (for phones).

## Production

```sh
npm run build && npm start   # one process, one port
```

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Port the server listens on. |
| `DATA_DIR` | `./data` | Uploaded media and cover art. Cleared on startup. |
| `MAX_UPLOAD_MB` | `300` | Maximum size of a single uploaded file. |
| `ROOM_IDLE_TTL_MIN` | `60` | Minutes an empty room survives before it and its files are deleted. |
| `LIBRARY_DIR` | unset | A music folder to search and play from rooms (see below). Unset disables the library. |
| `LIBRARY_RESCAN_MIN` | `360` | Minutes between library rescans. |
| `CREATE_ROOM_ON_JOIN` | `true` | Opening a link to an unknown room creates it, so links survive a restart. Set to `false` when room creation is behind authentication. |

### Docker

```sh
docker compose up -d --build   # builds the image locally and starts it on :3000
```

`compose.yaml` builds from this repo and tags the image `listening-room:local`.
Set `HOST_PORT`, `MAX_UPLOAD_MB`, `ROOM_IDLE_TTL_MIN`, or `CREATE_ROOM_ON_JOIN` in the environment or a
`.env` file next to it. Uploaded media lives in the `media` volume at `/data`; it
only holds files for live rooms and is cleared when the container starts.

Once images are published to GHCR, replace `build: .` and `image:` in
`compose.yaml` with the published image (`ghcr.io/OWNER/listening-room:TAG`).

Behind a reverse proxy, forward WebSocket upgrades and raise the upload limit.
For nginx:

```nginx
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
client_max_body_size 300m;
```

For caddy the default reverse_proxy behavior should work.

### Server music library

Set `LIBRARY_DIR` to a folder of music and anyone in a room can search it by
song, album, or artist and add tracks to the queue. With Docker, mount the
folder read-only and point `LIBRARY_DIR` at it:

```yaml
    environment:
      LIBRARY_DIR: /music
    volumes:
      - /srv/music:/music:ro
```

The server indexes the folder in the background at startup and rescans it
every `LIBRARY_RESCAN_MIN` minutes, re-reading only files that changed. The
index and album art are cached in `DATA_DIR`. Only formats browsers can play
are indexed (MP3, AAC/M4A, FLAC, Ogg Vorbis/Opus, WAV, WebM); ALAC and WMA are
skipped, since the app doesn't transcode.

Rooms play library tracks by reference: clients fetch only tracks someone added
to a live room, through that room's media URLs. Nothing in the library is
reachable without a room link. Anyone with a room link can search the whole
library, though.

#### Library report

`library-report` writes a Markdown report of problems in the library that the
app works around but that are better fixed in the files: formats browsers
can't play, duplicate tracks, album tag typos, missing tags, artist spelling
variants, and albums without art. It only reads the library, and it builds its
own temporary index, so it's safe to run while the server is up. A full scan of
about 5,000 tracks takes a couple of minutes.

```sh
npm run library-report -- /path/to/music --out library-notes.md   # from the repo
docker compose exec -T listening-room node server/dist/tools/libraryReport.js > library-notes.md
```

The library folder defaults to `LIBRARY_DIR`, and without `--out` the report
goes to standard output. From the repo, a relative `--out` path is relative to
the folder you run it in.

### Restricting who can start rooms

Everything about creating a room lives under `/start`: `GET /start` is the start
page, and its form posts back to `/start`, which creates the room and redirects
to `/r/<id>`. (`/` redirects to `/start`.) Joining and using a room goes through
`/r/*`, `/ws/*`, `/media/*`, `/api/*`, and `/assets/*`, which stay public.

To require a login to start rooms, protect `/start` at your proxy and set
`CREATE_ROOM_ON_JOIN=false`; otherwise anyone could create a room just by
opening `/r/<any-id>`. With it off, links to rooms that no longer exist (for
example after a restart) show "This room doesn't exist". For Caddy:

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

HTTPS is recommended: the clipboard API and some mobile browser behavior depend on it.

## Keyboard shortcuts

| Key | Action |
|---|---|
| Space | Play/pause |
| ← / → | Seek back/forward 10 s |
| Shift+← / Shift+→ | Previous / next |
| M | Mute |
| D | Toggle the debug panel |

## License

Listening Room is released under the [MIT License](LICENSE).

The web client bundles third-party packages and fonts (including Fraunces and
Public Sans under the SIL Open Font License 1.1). `npm run build` writes their
licenses to `client/dist/third-party-licenses.txt`, served at
`/third-party-licenses.txt`.
