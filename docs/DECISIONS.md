# AUX BATTLES — Architecture Decision Log

> Living document (owner approval item #1). Every architectural decision gets an entry:
> **date · decision · reason · alternatives considered · consequences**.
> Newest entries at bottom. This is the permanent design history — implementation never silently diverges from it; if reality disagrees with a decision, amend the decision here first, then change code.
> Status legend: ✅ active · 🔄 superseded (by entry #) · ⏸ deferred w/ trigger

---

## Pre-implementation design decisions (reconciled 2026-08-24)

These were adjudicated during design review (`docs/review-report.md`, rulings A–F) and are recorded here as the founding entries. Full rationale lives in the review report; consequences are restated because they bind implementers daily.

### D-A ✅ Room codes: 5 chars × 31-symbol alphabet
- **Date:** 2026-08-24
- **Decision:** Codes drawn from `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (31 symbols, no 0/O/1/I/L), 5 chars ≈ 28.6M keyspace, DB unique-index rejection-insert retry.
- **Reason:** Backend's math beat Arch's 4-letter proposal (~1.6% of keyspace burned by one party week); Security's 6-char floor overshot for rooms living ≤6h behind per-IP join rate-limits.
- **Alternatives:** 4-letter curated (rejected: enumerable); ≥6-char (rejected: typing cost on phones for marginal gain given lockout).
- **Consequences:** Generator must reject-insert on collision; join endpoint needs per-IP rate limit from day one (security 🔴).

### D-B ✅ Persistence: in-memory authoritative + SQLite WAL checkpoints
- **Date:** 2026-08-24
- **Decision:** Rooms live in memory; every transition/submission writes a WAL checkpoint via the `RoomStore` interface; SQLite is the only durable store in MVP.
- **Reason:** Party-scale write volume is trivial; Postgres would be an always-on second service violating the simplicity mandate. DB unique constraints remain the race backstop (`UNIQUE(round_id, player_id)`, `UNIQUE(round_id, client_msg_id)`, nickname `COLLATE NOCASE`).
- **Alternatives:** Postgres+Drizzle now (rejected → stage-1 swap); pure memory no disk (rejected: crash = dead party).
- **Consequences:** `RoomStore` interface must stay narrow so stage-1 Postgres is config, not surgery; boot sweep rehydrates rooms lazily.

### D-C ✅ Timers: armed per-room setTimeout + persisted deadlines
- **Date:** 2026-08-24
- **Decision:** One `setTimeout` per room while a timed phase runs; `phase_deadline` (epoch-ms) persisted; expiry re-enters FSM through room mutex as `TIMER_EXPIRED`; boot sweep re-arms overdue deadlines; ~60s sweeper handles TTL/cleanup only.
- **Reason:** Exact deadlines, drift-proof client countdowns derived from absolute deadline, serial resolution of expiry-vs-host-skip races; global 1s ticker was state-advancing complexity with no benefit (idle rooms hold zero timers).
- **Alternatives:** Global interval ticker scanning all rooms (rejected).
- **Consequences:** Clients compute countdowns locally from `phaseEndsAt`; `timer_tick` frames exist but clients may ignore them.

### D-D ✅ Protocol: REST mutations, read-mostly WebSocket
- **Date:** 2026-08-24
- **Decision:** All mutations via REST under `/api/v1`; WS pushes snapshots/heartbeats only (`ping`/`ack` up). Frame envelope `{t, ts, seq}` with per-room monotonic seq; reconnect = fresh handshake + full snapshot (no resync frame); rejoin via `/reclaim` ticket.
- **Reason:** One mutation path to authorize/idempotently-log; WS stays dumb pipe; gap detection trivial via seq.
- **Alternatives:** Pure WS actions (rejected: two write paths); SSE (rejected: no clean binary/later upgrade path, similar limits).
- **Consequences:** Frontend optimistic UI restricted to cosmetic actions; `@aux/shared` Zod schemas are the single protocol truth.

### D-E ✅ Manual playback mode is first-class (`playback_mode: api|manual|silent`)
- **Date:** 2026-08-24
- **Decision:** Mode broadcast in every snapshot. Manual mode = host-tap-driven advance ("Next"), round clock pauses between tracks; UI ships mode-specific host card + player banner from day one.
- **Reason:** Spotify Dev Mode previews presumed dead; API playback can degrade mid-party; manual mode is the product's insurance policy, not an apology screen.
- **Alternatives:** Treat manual as fallback screen built later (rejected by reviewer E).
- **Consequences:** Integration suite includes a full manual-mode round; winner-screen chorus gated on `api` mode.

### D-F ✅ Duplicate nicknames: reject-live + reclaim-after-disconnect
- **Date:** 2026-08-24
- **Decision:** `NAME_TAKEN` on live duplicates (case-insensitive); disconnected players' names become reclaimable via `/reclaim`, which invalidates the old token.
- **Reason:** Auto-suffix breaks stable reclaim identity; identity is the session token anyway.
- **Alternatives:** Auto-suffix `#2` (rejected).
- **Consequences:** Partial unique index on `(room_code, nickname COLLATE NOCASE) WHERE connected=1`.

### D-G ✅ Single Node.js process topology
- **Date:** 2026-08-24
- **Decision:** One Fastify process owns REST + WS + room state. No Redis, queues, or second service in MVP.
- **Reason:** Simplest thing that supports thousands of concurrent rooms later (stage-1: N processes behind room-hash router + RoomStore swap — contract unchanged).
- **Alternatives:** Split realtime/game services, Redis pub/sub now (all rejected as premature).
- **Consequences:** Vertical scale first; sticky routing documented as the stage-1 gate.

---

## Implementation-era decisions

### D-008 ✅ Governance docs adopted (this file, TASKS.md, TODO.md, PLAYTEST.md)
- **Date:** 2026-08-24 (owner approval conditions 1–4)
- **Decision:** Four living docs govern all implementation: DECISIONS.md (this log), TASKS.md (progress truth), TODO.md (no anonymous TODO comments — code markers cite `TODO(AUX-XXX)` rows), PLAYTEST.md (structured playtesting loop activating after Phase 2).
- **Reason:** Owner requirements: stoppable-at-any-time progress visibility, permanent design history, debt made explicit, success criterion measured not assumed.
- **Alternatives:** Issue-tracker tooling (deferred — repo-local files suffice for MVP team size).
- **Consequences:** Phase gates require TASKS.md updated; any code TODO without a board row fails review; playtest kill-criteria can pause feature work.

### D-009 ✅ Git workflow: conventional commits, small milestones
- **Date:** 2026-08-24 (owner condition 3)
- **Decision:** Commit after every meaningful milestone; conventional-commit scopes (`feat(room):`, `feat(fsm):`, `feat(spotify):`, `feat(judge):`, `refactor(shared):`); giant commits forbidden.
- **Reason:** Owner requirement + cheap bisectability.
- **Alternatives:** Squash-per-phase (rejected: loses history granularity).
- **Consequences:** CI runs on push; main stays green.

### D-010 ✅ In-process analytics event bus (no external service)
- **Date:** 2026-08-24 (owner condition 8)
- **Decision:** Typed analytics events emitted through an in-process bus with NDJSON file sink; events cover rooms created, games completed, avg players/rounds/round-time, host disconnects, reconnects, AI failures, Spotify failures, manual-playback usage. No external analytics SDK.
- **Reason:** Instrumentation from day one informs playtests and phase gates without adding a vendor dependency; event schema lives in `@aux/shared` like everything else.
- **Alternatives:** PostHog/GA now (violates "no external analytics yet"); console.log (not queryable).
- **Consequences:** Emitting must be fire-and-forget (never blocks game loop); sink rotation is out of MVP scope.

### D-011 ✅ Dev-only debug dashboard at `/dev`
- **Date:** 2026-08-24 (owner condition 7)
- **Decision:** Single developer page (dev builds only, server refuses route outside dev mode) listing live rooms, per-room FSM state, connected players, submissions received, armed timers, AI request log, provider status, recent WS events.
- **Reason:** Realtime state bugs dominate this codebase's risk; visible state cuts debugging time dramatically.
- **Alternatives:** Rely on logs only (too slow for race reproduction).
- **Consequences:** Server exposes read-only introspection endpoint guarded by env check; dashboard reads the same in-process registry the game uses (no second source of truth).

### D-012 ✅ LLM access behind provider-neutral `LLMProvider` interface
- **Date:** 2026-08-24 (owner condition 6)
- **Decision:** Judge consumes `LLMProvider { complete(req): Promise<JudgementRaw> }`. OpenRouter ships first; OpenAI/Anthropic/local are config-swappable implementations. Game logic never imports an SDK.
- **Reason:** Mirrors the MusicProvider doctrine (owner condition 5); judge fallback + budget cap sit above the interface so they survive vendor swaps.
- **Alternatives:** Hard-wire OpenRouter SDK into JudgeService (rejected).
- **Consequences:** FakeLLM in tests implements the same interface; budget cap enforced at the bus level, independent of vendor.

### D-013 ✅ Quality gates run before every phase completion
- **Date:** 2026-08-24 (owner conditions 9–10)
- **Decision:** `npm run typecheck && npm run lint && npm run format:check && npm run test` must pass before a phase is reported complete. UI work judged against owner philosophy: fast, responsive, fun, minimal clicks; animations may never delay gameplay.
- **Reason:** Broken-test debt compounds faster than feature debt in realtime systems.
- **Alternatives:** Phase-end cleanup sprints (rejected: debt accretes silently).
- **Consequences:** CI mirrors the same script; red CI = no phase report.

### D-014 ⏸ Spotify spike stop-and-report gate
- **Date:** 2026-08-24 (owner condition 11)
- **Decision:** Phase 2.5 spike probes real Dev Mode behavior before reveal/judging polish is built on top. Any major limitation (OAuth, playback reliability, Dev Mode caps, latency, rate limits) halts implementation; findings go to owner before proceeding.
- **Reason:** No assumptions stacked on unverified Spotify behavior — the deep-dive doc is research, not proof.
- **Alternatives:** Build optimistically, fix after (explicitly forbidden).
- **Consequences:** Phase 3+ tasks touching playback stay blocked until spike report approved; probe script tracked as AUX-001.

### D-015 ✅ Six-agent parallel workforce per phase
- **Date:** 2026-08-24 (owner standing order)
- **Decision:** Every phase is implemented by exactly 6 parallel agents with strictly separated file ownership (build · lint/format · tests · server/shared review · web review · independent reviewer gated on the other five). Controller owns integration, final quality-gate runs, commits, and governance-doc updates.
- **Reason:** Owner mandate: parallel throughput without merge hazards; independent review catches cross-cutting drift single-threaded work misses.
- **Alternatives:** Single-agent sequential implementation (rejected: slower, no adversarial check).
- **Consequences:** Cross-boundary findings are reported to the controller for routing, never edited out of scope; reviewers must not run while siblings still edit.

### D-016 ✅ Phase 0 correctness amendments (applied during six-agent review)
- **Date:** 2026-08-24
- **Decision:** Five corrections landed via specialist review: (1) room-code regex tightened from `[A-HJ-NP-Z2-9]` (32 symbols, admitted L) to exactly-31 `[A-HJKMNP-Z2-9]`, restoring D-A; (2) analytics NDJSON sink actually started at boot + async stream-error handler so analytics can never crash the process (D-010); (3) SIGTERM handled alongside SIGINT for container shutdowns; (4) rate-limiter `retryAfterSecs` prunes stale hits before reporting; (5) web entry resolution via `fileURLToPath` (Windows-safe) + CSS import paths fixed.
- **Reason:** Review agents found real defects the initial skeleton shipped; each fix verified against its decision's intent.
- **Alternatives:** Leave to later phases (rejected: security/correctness debt compounds).
- **Consequences:** Alphabet property tests now pin the exact 31-symbol contract; shutdown path shared by both signals.

### D-017 ✅ Phase 2 integration: runtime composition + host-control surface
- **Date:** 2026-08-25 (reviewer findings 🔴#1/#2)
- **Decision:** The committed FSM/TimerService/RoomStore parts are bound in the composition root: `gameRuntimesRoute` exposes host controls (`POST /rooms/:code/host/:action`) and `/reclaim`; every transition checkpoints via the FSM `onChange` hook; lazy rehydration seeds fresh rooms and rebuilds persisted ones with boot-sweep timer re-arm; TTL sweeper wired cleanup-only. `INVALID_ACTION` added to the error enum (additive, contract-safe). WS hub gains a `setSnapshotBuilder` seam for tests/controller wiring.
- **Reason:** Independent review correctly ruled the Phase 2 deliverable "a parts kit, not a running machine" — TDD §13 Phase 2 scope requires full FSM + timers + host controls + reconnect/reclaim as a live system.
- **Alternatives:** Defer wiring to Phase 3 round flow (rejected: reviewer hold on COMPLETE designation is correct — unwired state cannot satisfy the phase gate).
- **Consequences:** Live wire-verified: create → start_game → pick_category → SCENARIO with armed 8s deadline → autonomous TIMER_EXPIRED advance to SONG_SELECTION. Known follow-up AUX-006: WS default snapshot still hardcodes LOBBY until the FSM-backed builder replaces it. Kick command deferred to Phase 3 roster work.
