# AUX BATTLES — Implementation Tasks

> Single source of progress truth. Updated as work completes — anyone should be able to stop development at any point and read exact status here.
> Gate for every phase: `npm run typecheck && npm run lint && npm run format:check && npm run test` green, then phase report + owner approval.

## Phase 0 — Foundation *(in progress)*
- [x] Governance docs (DECISIONS / TASKS / TODO / PLAYTEST) + TDD amendments
- [ ] Monorepo scaffold: root package.json, workspaces, tsconfigs, .gitignore
- [ ] ESLint (flat) + Prettier wired to quality-gate script
- [ ] GitHub Actions CI: install → typecheck → lint → test → build
- [ ] `@aux/shared`: constants (alphabet, limits, timings), Zod schemas, WS frame types, error-code enum, analytics events
- [ ] Server skeleton: Fastify bootstrap, `/healthz`, token minting/verify, in-memory rate limiter, config module
- [ ] Server tests: token roundtrip, negative authZ cases, rate-limiter behavior
- [ ] Web skeleton: Vite + SolidJS dual-entry (`host.html`, `player.html`), shared-ui shell
- [ ] Analytics event bus (in-process, NDJSON sink) + dev-mode `/dev` dashboard shell
- [ ] Vitest wiring both packages; FakeProvider/FakeLLM seams stubbed
- [ ] Quality gate green end-to-end; conventional-commit history

## Phase 1 — Join flow (landing → lobby)
- [ ] Landing page (create/join CTAs)
- [ ] `POST /rooms` + 5×31 room-code generator w/ collision retry
- [ ] QR code generation (join URL) on host lobby
- [ ] `POST /rooms/:code/join` + nickname validation + NAME_TAKEN path
- [ ] Lobby screens: host roster view, phone waiting view
- [ ] Join <15 s measured on real phones

## Phase 2 — Realtime core
- [ ] Room FSM engine (table-driven, illegal transitions rejected, async mutex)
- [ ] WS hub: connect-ticket handshake, snapshot push, `{t,ts,seq}`, heartbeat 15 s
- [ ] TimerService: armed setTimeout + persisted deadline + boot sweep
- [ ] Host controls: start, category pick, skip, kick
- [ ] Reconnect/reclaim flow; duplicate-join supersede; late-join rules; host migration
- [ ] Integration hard-case suite (simultaneous submits, refresh mid-round, expiry w/ live sockets…)
- [ ] **PLAYTEST.md loop becomes active**

## Phase 2.5 — Spotify SPIKE ⚠️ *stop-and-report gate*
- [ ] Day-one probes: preview_url availability, transfer latency, rate ceiling, device reliability
- [ ] Preload-and-verify playback orchestrator behind `MusicProvider`
- [ ] OAuth PKCE server-side flow + encrypted token store
- [ ] Search proxy (`POST /search`)
- [ ] L0 (API autoplay) AND L4 (manual) demo-able
- [ ] **If major limitation found: STOP implementation, present findings to owner**

## Phase 3 — Submissions & round flow
- [ ] `POST /rounds/:id/submissions` w/ idempotency (`client_msg_id`)
- [ ] Server-side shuffle (anonymity) + `submission_received` count-only broadcasts
- [ ] Song search UI (pinned search, sticky pick bar, SURE? confirm, sealed state)
- [ ] LOCKED staging state; quorum early-fire; timer expiry → CHICKEN 🐔 random assignment
- [ ] Concurrency tests green

## Phase 4 — AI Judge & reveal
- [ ] `LLMProvider` interface + OpenRouter impl (config-switchable)
- [ ] Batched judging: prompt build, strict schema parse, permutation validation, retries, fallback judge
- [ ] Results persistence + leaderboard math
- [ ] Reveal choreography (beat-timed worst→best, owner reveal, reduced-motion fallback)
- [ ] Winner screen + next-round loop

## Phase 5 — Polish & deploy
- [ ] k6 load gate: 50 rooms × 8 players thresholds green (500×8 headroom variant)
- [ ] Fly.io deploy (single app + SQLite volume, WSS)
- [ ] Structured playtest #1 executed, findings logged in PLAYTEST.md
- [ ] Reveal timing polish from playtest data
- [ ] Definition-of-success checklist walked end-to-end on real devices

## Frozen (owner must explicitly request — do not build)
Category voting · READY toggles · emoji reactions · accounts/auth · admin panels · i18n · delta protocols · native apps · Redis/Postgres/Kafka (until stage-1 scale trigger)
