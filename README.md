# AUX BATTLES

A real-time party game where players anonymously submit songs for a scenario and an AI judge ranks the round. One Fastify process serves the REST API, WebSocket hub, SolidJS host/player clients, SQLite checkpoints, zero-setup song entry, and consistent whole-round judging with crowd voting when AI is unavailable.

## Run locally

Requirements: Node.js 22+ (CI and the production image use Node 26).

```sh
npm ci
cp .env.example .env
npm run dev
```

Open `http://127.0.0.1:5173/host.html`. The launcher starts the API and hot-reloading frontend together. No music provider is required: players can enter any song title and artist, and the host opens it in their preferred music service. Put a server-only `OPENROUTER_API_KEY` in `.env` and every host gets the **AI judge** for free, with no sign-in (`AUX_AI_ACCESS=open`, the default); the host can pick **crowd voting** instead on the start page. Without a key, rooms use crowd voting. Spending is capped by default at 30 AI games, $0.50 per day and $3 per month; when a cap is reached the screens say DJ AUX is off duty and the room votes instead, and an AI failure sends just that round to crowd voting. See [AI judge setup](docs/ai-judge.md). The optional paid iOS mode (`AUX_AI_ACCESS=account`) is documented in [billing](docs/billing.md).

## Validation

```sh
npm run gate       # typecheck, lint, formatting, complete test suite
npm run build      # shared package, server, and both web entries
npm audit --omit=dev
```

The integration suite covers the complete manual game loop and SQLite process-restart recovery. With [k6](https://grafana.com/docs/k6/latest/set-up/install-k6/) installed, run the 50-room × 8-player gate against a built server:

```sh
BASE_URL=http://127.0.0.1:8787 k6 run infra/k6-smoke.js
```

## Production

The public site is `/host.html` (the root redirects there); players join at `/player.html`. Before sharing the link, work through the owner checklist in [DEPLOY.md](DEPLOY.md).

The repository includes a multi-stage `Dockerfile` and `fly.toml`. Before the first Fly deployment:

```sh
fly volumes create aux_data --region osl --size 1
fly secrets set OPENROUTER_API_KEY=...
fly deploy
```

Keep one machine running: the MVP deliberately owns rooms and sockets in one process, with SQLite on `/data`. `/healthz` is the liveness endpoint and `/dev/state` exists only with `AUX_DEV_MODE=1`.

The default mode requires no music credentials or linked account: players enter any song title and artist, and the host gets links to find it in Apple Music or YouTube before advancing. Optional [YouTube song search and embedded video playback](docs/youtube-music.md) requires a Data API key. An API key is not commercial music clearance: review the [release readiness checklist](docs/RELEASE-READINESS.md), provider policies, privacy disclosures, and intended music usage before launch. [Deezer 30-second previews](docs/deezer-music.md) remain an explicit playtest opt-in (`AUX_DEEZER_PREVIEWS=1`). [Apple MusicKit](docs/apple-music.md) is an optional catalog/playback integration using the host's subscription. The publisher-controlled [licensed music mode](docs/licensed-music.md) supports recordings with explicit game rights. Legacy AUX Originals are disabled by default.

The iOS and Android Capacitor projects, device commands, signing steps, and
release checklist are documented in [docs/mobile-app.md](docs/mobile-app.md).

Architecture and product decisions live in [docs/TDD.md](docs/TDD.md), operational/playtest gates in [docs/PLAYTEST.md](docs/PLAYTEST.md), and current completion status in [docs/TASKS.md](docs/TASKS.md).
