# AUX BATTLES — Implementation Tasks

> Single source of progress truth. Updated as work completes — anyone should be able to stop development at any point and read exact status here.
> Gate for every phase: `npm run typecheck && npm run lint && npm run format:check && npm run test` green, then phase report + owner approval.

## Phase 0 — Foundation *(complete — reviewer verdict PASS-WITH-NOTES)*
- [x] Governance docs (DECISIONS / TASKS / TODO / PLAYTEST) + TDD amendments
- [x] Monorepo scaffold: root package.json, workspaces, tsconfigs, .gitignore
- [x] ESLint (flat) + Prettier wired to quality-gate script
- [x] GitHub Actions CI: install → typecheck → lint → test → build
- [x] `@aux/shared`: constants (alphabet, limits, timings), Zod schemas, WS frame types, error-code enum, analytics events
- [x] Server skeleton: Fastify bootstrap, `/healthz`, token minting/verify, in-memory rate limiter, config module
- [x] Server tests: token roundtrip, negative authZ cases, rate-limiter behavior *(authZ-negatives deferred to Phase 1 with routes — W6 finding #2)*
- [x] Web skeleton: Vite + SolidJS dual-entry (`host.html`, `player.html`), shared-ui shell
- [x] Analytics event bus (in-process, NDJSON sink) + dev-mode `/dev` dashboard shell
- [x] Vitest wiring both packages; FakeProvider/FakeLLM seams stubbed
- [x] Quality gate green end-to-end; conventional-commit history

**Carried into Phase 1 from review:** negative authZ route tests · `vi.useFakeTimers()` rate-limiter window-expiry case (findings #2/#3).

## Phase 1 — Join flow *(complete — reviewer PASS-WITH-NOTES; live smoke-tested)*
- [x] Landing page (create/join CTAs)
- [x] `POST /rooms` + 5×31 room-code generator w/ collision retry
- [x] QR code generation (join URL) on host lobby
- [x] `POST /rooms/:code/join` + nickname validation + NAME_TAKEN path
- [x] Lobby screens: host roster view, phone waiting view
- [ ] Join <15 s measured on real phones *(device measurement = owner playtest item)*
- [x] Negative authZ route tests — N/A this phase by contract: all Phase 1 endpoints are public; NOT_HOST/NOT_AUTHENTICATED surfaces arrive with the Phase 2 WS hub + host controls (reviewer-endorsed rationale)
- [x] Fake-clock rate-limiter expiry test (carried from Phase 0 review)

## Phase 2 — Realtime core *(complete — reviewer PASS-WITH-NOTES resolved by controller integration; live wire-verified)*
- [x] Room FSM engine (table-driven, illegal transitions rejected, async mutex)
- [x] WS hub: connect-ticket handshake, snapshot push, `{t,ts,seq}`, heartbeat 15 s
- [x] TimerService: armed setTimeout + persisted deadline + boot sweep
- [x] Host controls: start, pick_category, skip_phase, begin_playback, advance_reveal, next_round, finish_game (kick lands with roster mgmt in Phase 3)
- [x] Reconnect/reclaim flow (server + clients); duplicate-join supersede · late-join rules + host migration land in Phase 3 round flow
- [x] Integration hard-case suite (simultaneous submits, refresh mid-round, expiry w/ live sockets…)
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
