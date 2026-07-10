# Content Broadcast

Digital signage for venue: show YouTube live, ABEMA news, or any
video stream on the Android TVs around the venue, all controlled from one admin page.

```
┌─ Admin browser ──► Admin UI (React, served by the server)
│
▼                     LAN mini-PC / NAS (Docker)
┌──────────────────────────────────────────────────────┐
│  Fastify API + WebSocket hub + SQLite                │
│  Stream pipeline: yt-dlp ──► ffmpeg ──► HLS on disk  │──► VPN / proxy egress
│  Serves: /streams/<id>/index.m3u8, admin UI          │    (pulls YouTube/ABEMA once)
└──────────────────────────────────────────────────────┘
        ▲ WebSocket (commands + heartbeat)  ▲ HLS over the LAN
   ┌────┴────┐                         ┌────┴────┐
   │  TV app │      ... per TV ...     │  TV app │   Android TV, Kotlin + ExoPlayer
   └─────────┘                         └─────────┘
```

## Features

- Displays register themselves the first time the TV app connects — rename them in
  the admin UI.
- Per-display **playlists** (YouTube, ABEMA, direct HLS/MP4 URLs, mixed), with
  optional per-item duration for rotating live channels.
- **Play now**: paste a link, it plays on one display immediately, then the display
  falls back to its playlist.
- **Broadcast mode**: one click sends the same content to every display at once.
- Live preview of any running stream inside the admin UI.
- Streams start on demand, are shared between displays, restart on failure, and stop
  ~30 s after the last display leaves.

## Quick start (server)

Needs Docker on a mini-PC/NAS on the venue LAN.

```bash
git clone <this repo> && cd content-broadcast
# optional: egress proxy for pulling blocked sources (see next section)
echo "RESTREAM_PROXY=http://<proxy-host>:<port>" > .env
docker compose up -d --build
```

Open `http://<server-ip>:8080` — that's the admin UI.

### Without Docker (development)

```bash
# terminal 1 — API server on :8080 (needs ffmpeg + yt-dlp on PATH)
cd server && npm install && npm run dev

# terminal 2 — admin UI with hot reload on :5173, proxying /api to :8080
cd server/web && npm install && npm run dev
```

## Getting past the blocked network

The server needs a route to YouTube/ABEMA; pick one:

1. **`RESTREAM_PROXY` (simplest)** — point it at any HTTP or SOCKS5 proxy that can
   reach the sources (a Clash/sing-box box on the LAN, a VPS tunnel, ...). Only
   yt-dlp/ffmpeg traffic uses the proxy; nothing else changes.
2. **VPN on the host** — run WireGuard/OpenVPN on the server host (or a TUN-mode
   proxy client) so the whole container egresses through it. Leave
   `RESTREAM_PROXY` empty.
3. **Policy routing on the router** — route only the server's IP through a VPN
   at the router level.

Notes:

- **ABEMA** is geo-locked to Japan, so the egress must exit in Japan for it. The
  free news channel generally works via yt-dlp; DRM-protected shows will not.
- yt-dlp ages quickly. Refresh it inside the container occasionally:
  `docker compose exec broadcast yt-dlp -U` (or rebuild the image).
- If a source's codecs won't stream-copy into HLS (rare for YouTube live), set
  `RESTREAM_TRANSCODE=1` to force H.264/AAC transcoding (costs CPU).
- Re-serving geo-blocked platforms in a public venue sits in a gray zone of their
  terms of service — fine to evaluate in a private workspace, worth a conscious
  decision for a public café.

## TV app (Xiaomi / any Android TV)

The APK is built by GitHub Actions on every push — grab
**content-broadcast-tv-debug** from the workflow run's artifacts, or build locally
by opening `tv-app/` in Android Studio (`gradle assembleDebug`).

Install on a Xiaomi TV:

1. Enable *Developer options* (Settings → About → click the build number a few
   times), turn on *USB debugging / Install via USB*, then either:
   - `adb connect <tv-ip> && adb install app-debug.apk`, or
   - copy the APK onto a USB stick and open it with the TV's file manager.
2. Launch **Content Broadcast**, enter the server address (`192.168.1.10:8080`),
   press *Connect*.
3. The display appears in the admin UI — rename it, assign a playlist, done.
   The app reconnects by itself and relaunches after the TV reboots.

Tip: leave the TV's "auto power on with HDMI/power" enabled so the whole chain is
hands-off after a power cut.

## How playback is decided

Priority per display: **broadcast** (all displays) → **play now** (ad-hoc) →
**assigned playlist**. Playlist items advance when a video ends, or after
`duration` seconds for items that never end (live channels). Ad-hoc content
returns to the playlist when it finishes or when you press *stop*.

URLs entered anywhere accept:

| Kind | Example | Handling |
| --- | --- | --- |
| YouTube video/live | `https://www.youtube.com/watch?v=...` | resolved by yt-dlp, restreamed |
| ABEMA channel | `https://abema.tv/now-on-air/abema-news` | resolved by yt-dlp, restreamed |
| Direct HLS/MP4/RTMP | `http://.../stream.m3u8` | restreamed as-is (no yt-dlp) |
| LAN media (restream off) | uncheck *Restream* on the item | TV plays it directly |

## API sketch

`GET /api/state` — everything the admin UI shows (displays, playlists, broadcast,
active channels). Mutations: `POST /api/displays/:id/play|stop|assign`,
`POST|DELETE /api/broadcast`, playlist CRUD under `/api/playlists`. TVs connect to
`ws://server:8080/ws` and exchange JSON: `hello` / `status` / `ended` up,
`play` / `stop` / `ping` down. Restreamed output is plain HLS under
`/streams/<channel>/index.m3u8` — anything that plays HLS can watch it.

## Repo layout

```
server/       Fastify + TypeScript backend (API, WebSocket hub, stream manager)
server/web/   React admin UI (vite build -> server/public)
tv-app/       Android TV client (Kotlin, Media3 ExoPlayer)
Dockerfile    server + ffmpeg + yt-dlp runtime image
```
