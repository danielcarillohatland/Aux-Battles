# AUX BATTLES

A real-time party game where players anonymously submit songs for a scenario and an AI judge ranks the round. One Fastify process serves the REST API, WebSocket hub, SolidJS host/player clients, SQLite checkpoints, Spotify playback integration, and the fallback-safe judge.

## Run locally

Requirements: Node.js 22+ (CI and the production image use Node 26).

```sh
npm ci
cp .env.example .env
npm run build
npm run dev:server
```

Open `http://127.0.0.1:8787/host.html`. For live frontend development, run `npm run dev:web` in a second terminal. Spotify and OpenRouter credentials are optional: without Spotify the game uses first-class manual playback; without OpenRouter it uses the deterministic fallback judge.

## Validation

```sh
npm run gate       # typecheck, lint, formatting, 244+ tests
npm run build      # shared package, server, and both web entries
npm audit --omit=dev
```

The integration suite covers the complete manual game loop and SQLite process-restart recovery. With [k6](https://grafana.com/docs/k6/latest/set-up/install-k6/) installed, run the 50-room × 8-player gate against a built server:

```sh
BASE_URL=http://127.0.0.1:8787 k6 run infra/k6-smoke.js
```

## Production

The repository includes a multi-stage `Dockerfile` and `fly.toml`. Before the first Fly deployment:

```sh
fly volumes create aux_data --region osl --size 1
fly secrets set AUX_TOKEN_KEY=... SPOTIFY_CLIENT_ID=... SPOTIFY_CLIENT_SECRET=... \
  SPOTIFY_REDIRECT_URI=https://YOUR_APP.fly.dev/api/v1/spotify/callback OPENROUTER_API_KEY=...
fly deploy
```

Use a random 32-byte `AUX_TOKEN_KEY`. Keep one machine running: the MVP deliberately owns rooms and sockets in one process, with SQLite on `/data`. `/healthz` is the liveness endpoint; `/dev/state` and Spotify token debugging exist only with `AUX_DEV_MODE=1`.

Architecture and product decisions live in [docs/TDD.md](docs/TDD.md), operational/playtest gates in [docs/PLAYTEST.md](docs/PLAYTEST.md), and current completion status in [docs/TASKS.md](docs/TASKS.md).
