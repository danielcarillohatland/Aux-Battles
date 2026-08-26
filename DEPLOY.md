# Deploying to Fly.io

Status on this machine (checked 2026-08-26): **not deployable yet.**

| Requirement               | Status                                                                             |
| ------------------------- | ---------------------------------------------------------------------------------- |
| `flyctl` CLI              | MISSING - not installed                                                            |
| Fly.io auth token         | MISSING - none in `.env` or env vars                                               |
| `fly.toml` + `Dockerfile` | Present (app `aux-battles`, region `osl`, volume `aux_data` -> `/data`, port 8787) |

## Setup (owner must run these once)

```sh
# 1. Install the CLI (macOS)
brew install flyctl

# 2. Log in (opens browser)
flyctl auth login

# 3. Create the persistent volume (matches [[mounts]] source=aux_data in fly.toml).
#    Required before first deploy: the app stores SQLite + tokens + analytics in /data.
flyctl volumes create aux_data --region osl --size 1

# 4. Set runtime secrets (never commit these; local .env is NOT uploaded)
flyctl secrets set \
  SPOTIFY_CLIENT_ID=<your-id> \
  SPOTIFY_CLIENT_SECRET=<your-secret> \
  OPENROUTER_API_KEY=<your-key>
```

## Deploy

```sh
flyctl deploy
```

Fly builds the `Dockerfile` remotely (multi-stage Node build), attaches the
volume at `/data`, and starts the server on port 8787.

## Verify

```sh
flyctl status              # machines running, version deployed
flyctl logs                # watch boot output
curl https://aux-battles.fly.dev/healthz   # health check path from fly.toml
```

## Notes

- App name and region come from `fly.toml` (`aux-battles` / `osl`); do not pass
  `-a` or `--region` on deploy.
- If the app exists already, skip step 3 (volume persists across deploys).
- To rotate a secret later: re-run `flyctl secrets set KEY=value`.
