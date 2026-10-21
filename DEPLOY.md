# Deploying to Fly.io

The app can run with manual song entry and host-managed playback. AUX Originals
are disabled by default. Review [release readiness](docs/RELEASE-READINESS.md)
before opening a paid or public service.

| Requirement               | Status                                                                             |
| ------------------------- | ---------------------------------------------------------------------------------- |
| `flyctl` CLI              | Install with `brew install flyctl`                                                 |
| Fly.io auth token         | MISSING - none in `.env` or env vars                                               |
| `fly.toml` + `Dockerfile` | Present (app `aux-battles`, region `osl`, volume `aux_data` -> `/data`, port 8787) |

## Setup (owner must run these once)

```sh
# 1. Install the CLI (macOS)
brew install flyctl

# 2. Log in (opens browser)
flyctl auth login

# 3. Create the persistent volume (matches [[mounts]] source=aux_data in fly.toml).
#    Required before first deploy: the app stores SQLite + analytics in /data.
flyctl volumes create aux_data --region osl --size 1

# 4. Required for real AI judging (without it, rooms use crowd voting).
flyctl secrets set OPENROUTER_API_KEY=<your-key>

# 5. Public publisher details for "Help & privacy" (required for iOS release):
flyctl secrets set AUX_PUBLISHER_NAME="<name>" AUX_PRIVACY_URL=https://... \
  AUX_TERMS_URL=https://... AUX_SUPPORT_URL=https://...
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

`/healthz` checks server liveness, not provider credentials. Create a room and
check the lobby's judge status, then complete a real test round with funded
credentials before launch. See [AI judge operations](docs/ai-judge.md) for the
model, request limits, timeout behavior, and safe diagnostics. Set a provider
credit cap as well. Persistent SQLite daily/monthly reservations survive restart; the additional process request counter resets. Configure the Apple identity and StoreKit settings in [billing setup](docs/billing.md) before selling AI game packs.

## Owner checklist before sharing the link

The code is ready; these steps need your accounts, money or decisions.

1. **Cap the OpenRouter key itself.** In the OpenRouter dashboard, set a credit
   limit on the key (for example $5). This safety net works even if the app's
   own caps were misconfigured.
2. **First deploy** (from the repo root):

   ```sh
   brew install flyctl              # already done on the development Mac
   flyctl auth login                # opens the browser; needs a Fly account + card
   flyctl apps create aux-battles   # if the name is taken, pick another and update fly.toml
   flyctl volumes create aux_data --region osl --size 1
   flyctl secrets set OPENROUTER_API_KEY=<your-key>
   flyctl deploy
   ```

   The game is then live at **https://aux-battles.fly.dev**. It has never been
   deployed before, so expect a first-deploy fix or two.

3. **Your CV subdomain** (when you have the domain, e.g. `yourname.no`):
   - In `fly.toml`, set **both** `AUX_PUBLIC_ORIGIN` lines to
     `https://aux.yourname.no`.
   - `flyctl certs add aux.yourname.no`, then add the DNS record it prints at
     your registrar: a `CNAME` from `aux` to `aux-battles.fly.dev`.
   - `flyctl deploy` again. Link previews, the share card and the privacy link
     switch to the new address automatically.
4. **Privacy page.** A draft is bundled at `/privacy.html`
   (`apps/web/public/privacy.html`) and linked from "Help & privacy". Read it,
   adjust anything that is not true for you, and optionally set
   `flyctl secrets set AUX_PUBLISHER_NAME="Your Name"`.
5. **One real AI round.** Play a round, or run `npm run judge:eval -- --live`
   (about one cent), to confirm the judge works with the real model.
6. **Search.** Link the site from your CV/portfolio and submit the domain in
   Google Search Console. Indexing takes days to weeks.

Free AI defaults (override with Fly env or secrets): 30 AI games per day,
$0.50 per day, $3 per month. When a cap is reached, the room votes instead
and the screens say "DJ AUX is off duty for today".

## Production behavior worth knowing

- **One machine only.** Rooms, WebSockets and timers are in-process; SQLite on
  `/data` holds checkpoints, game credits, budgets and moderation reports.
  Scaling past one machine splits rooms across processes.
- `AUX_TRUST_PROXY` is a **hop count** (Fly = 1). Never set it higher than the
  real number of proxies, or clients can spoof `X-Forwarded-For` and bypass
  per-IP rate limits.
- API responses are `no-store`; hashed `/assets/*` bundles are cached for a
  year; HTML revalidates. All responses send `nosniff`, a strict referrer
  policy, and deny framing (except the YouTube relay page for allowed origins).
- Unexpected errors return `{ok:false,error:{code:"INTERNAL"}}`; details stay
  in `flyctl logs`.
- Player reports land in the `support_reports` table of `/data/aux.sqlite`
  (pending/reviewed/dismissed). There is no admin UI yet. The image has no
  `sqlite3` CLI; from `flyctl ssh console` run:
  `node -e "const D=require('better-sqlite3');console.table(new D('/data/aux.sqlite',{readonly:true}).prepare(\"SELECT id,kind,captured_content,details,created_at FROM support_reports WHERE status='pending'\").all())"`

## Notes

- App name and region come from `fly.toml` (`aux-battles` / `osl`); do not pass
  `-a` or `--region` on deploy.
- If the app exists already, skip step 3 (volume persists across deploys).
- To rotate a secret later: re-run `flyctl secrets set KEY=value`.
