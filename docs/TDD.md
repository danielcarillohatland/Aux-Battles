# AUX BATTLES — Technical Design Document (MVP)

**Status:** v1.1 — **APPROVED** by product owner 2026-08-24 · canonical spec for implementation · Review ruling: GO-WITH-CONDITIONS (all 6 conditions baked in below; governance additions in `DECISIONS.md` D-008…D-014)
**Sources:** `architecture.md` · `backend-spec.md` · `frontend-spec.md` · `../aux-battles-spotify-deep-dive.md` · `testing-strategy.md` · `security-review.md` · `review-report.md`
Where a source doc conflicts with this document, **this document wins** (adjudications in §2).

---

## 1. Product Definition

- Real-time social party game: players match songs to scenarios; an **AI Judge ranks every submission** — no player voting.
- Host connects **their own Spotify Premium** (OAuth); all playback through the host's device. Players never touch Spotify.
- Join = scan QR → type nickname → play. Target <15 s, zero installs, zero accounts.
- Submissions are **anonymous** until after the reveal; server-side shuffling protects anonymity.
- Signature moment: the **reveal** — worst-to-best countdown with witty AI explanations, then owners, leaderboard, next round.
- Rewards creativity/humor/taste. Never trivia knowledge.
- **Success metric:** *would people voluntarily play another round?* Everything else is secondary.

## 2. Adjudicated Decision Register (canonical)

| # | Decision | Ruling | Loser / amendment |
|---|----------|--------|-------------------|
| D-A | **Room codes**: 5 chars × 31-symbol alphabet `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (~28.6M keyspace), DB unique-index rejection-insert | Backend wins | Arch 4-letter deleted (fixes its bad `40^4` math); Security's ≥6-char floor replaced by 5×31 **+ enforced per-IP join rate-limit/lockout** |
| D-B | **Persistence**: authoritative in-memory rooms + **SQLite (WAL)** checkpoints behind `RoomStore` | Architecture wins for MVP | Postgres/Drizzle becomes the stage-1 scale swap (config change, not surgery). Backend's integrity model survives: port unique constraints into SQLite (§6) so the DB stays the race backstop |
| D-C | **Timers**: ONE `setTimeout` per room while a timed phase is armed; `phase_deadline` persisted (epoch-ms); expiry re-enters FSM through the room mutex as `TIMER_EXPIRED`; boot sweep re-arms overdue deadlines; ~60s interval sweeper for TTL/cleanup only | Backend wins | Arch's global 1s ticker deleted as state-advancer (idle rooms hold zero timers; Node handles hundreds trivially) |
| D-D | **Protocol**: REST for ALL mutations; WebSocket read-mostly (`ping/ack` only). Frame envelope `{t, ts, seq}`; full-snapshot resync via fresh handshake; rejoin via `/reclaim` ticket | Backend wins | Frontend §3 sketch rewritten (its invented `vote/lock/ready/resync` frames and event vocabulary dropped). Heartbeat = **15s** |
| D-E | **Playback modes**: `playback_mode: 'api' \| 'manual' \| 'silent'` broadcast in every snapshot. **Manual mode is first-class, host-tap-driven** (host taps “Next” between tracks; round clock pauses between tracks) | Deep-dive endorsed + extended | Previews presumed dead in Dev Mode; `previewOnly` cue path demoted to day-one probe. Frontend gains manual-mode card/banner |
| D-F | **Duplicate nicknames**: reject live duplicates (`NAME_TAKEN`); disconnected players' names reclaimable via `/reclaim`, which invalidates the old session token | Backend + Testing win | Auto-suffix `#2` policies (Arch, Frontend) deleted — suffix breaks stable reclaim identity |

## 3. System Architecture

```
┌────────────────────────── Single Node.js process (Fastify) ──────────────────────────┐
│  REST API ──┐                                                                        │
│             ├─► RoomManager ──► Room FSM instances (in-memory, authoritative)        │
│  WS hub ────┤         │              │                                                │
│  (read-mostly)       │        RoomStore iface ◄── SQLite WAL (checkpoints/WAL)       │
│                      │                                                              │
│              TimerService (per-room setTimeout + boot sweep + 60s TTL sweeper)       │
│              JudgeService (batched LLM, validated, fallback) │ MusicProvider iface   │
└──────────────────────────────────────────────┬───────────────────────────────────────┘
                                               │ constructor-injected at composition root
                                   SpotifyProvider (src/providers/)   FakeProvider (tests)
```

- **Topology:** one process owning REST + WS + rooms. No Redis, no queue, no second service. Rooms are node-local; stage-1 scale = run N processes behind a room-code-hash router + swap `RoomStore` to Postgres.
- **Room lifecycle:** create → 4–6h hard cap; empty-room TTL 10 min; `ROOM_CLOSED` broadcast on expiry; codes recyclable after deletion.
- **Sessions:** server-minted unguessable tokens (`hostToken`, `playerToken`, ≥128-bit). Identity/role derived **only** server-side from the token — never from payloads.
- **Crash recovery:** write-ahead checkpoint per transition + per submission; lazy rehydration on touch; deadline catch-up via boot sweep. Restart mid-party ≈ 5 s blip, accepted residual.

## 4. Game FSM

States: `LOBBY → CATEGORY → SCENARIO → SONG_SELECTION → LOCKED → PLAYBACK → AI_JUDGING → RESULTS → LEADERBOARD → (NEXT_ROUND ↺ | GAME_OVER)`

| State | Exits via | Owner |
|---|---|---|
| LOBBY | Host presses Start | host action |
| CATEGORY | Host picks category (voting CUT) | host action |
| SCENARIO | Timer (scenario shown ~8s) or host skip | timer |
| SONG_SELECTION | Timer (default 90s, host-adjustable) OR all-submitted early-fire | timer / quorum |
| LOCKED | Host taps Play (staging; closes submit/playback race) | host action |
| PLAYBACK | All songs played (API mode: queue done · Manual: host taps Next through queue) | provider events / host taps |
| AI_JUDGING | Judgement validated & stored (timeout 20s → fallback judge) | async job |
| RESULTS | Host advances reveal steps (or auto-advance timer) | host / timer |
| LEADERBOARD | Host presses Next Round / Finish | host action |

Implementation: **hand-rolled table-driven FSM (~80 lines)** — literal adjacency map, illegal `(state, event)` pairs rejected, side-effects isolated in an `onChange` hook. Per-room **async mutex serializes every transition** (resolves timer-expiry vs host-skip races). Timed phases carry `phaseEndsAt` (absolute epoch-ms) in snapshots; clients render countdowns locally from the deadline (drift-proof); 1 Hz `timer_tick` frames exist but clients may ignore them.

Edge rules: duplicate joins keyed by playerId supersede old socket; reconnect window 120 s (submission survives); late join allowed in `LOBBy`/early `SONG_SELECTION` only (snapshot on entry, excluded from judge input if joined mid-round); host disconnect → 120 s grace → **host migration** to earliest remaining player (must-have).

## 5. API & Realtime Contract

**REST (mutations — the only write path):** ~14 endpoints under `/api/v1`:
`POST /rooms` · `POST /rooms/:code/join` · `GET /rooms/:code/snapshot` · `POST /reclaim` · `POST /rounds/:id/submissions` · `POST /search` (provider proxy) · host: `start_game`, `pick_category`, `skip_phase`, `begin_playback`, `manual_next`, `advance_reveal`, `next_round`, `finish_game`, `kick`.
Error envelope: `{ok:false, error:{code,message,details}}`, stable 10-code enum (`NAME_TAKEN`, `ALREADY_SUBMITTED`, `NOT_HOST`, `ROOM_CLOSED`, …).

**WS (read-mostly):** client sends only `ping`/`ack`. Server pushes: `state_change` (full snapshot + private `you.hasSubmitted` slice), `timer_tick`, `submission_received` (count only — anonymity), `phase_expired`, `playback_cue` (host-only), `judgement`, `reveal_owner`, roster/lifecycle (`ROOM_CLOSED`, `kicked`). Every frame carries `{t, ts, seq}`; seq is per-room monotonic → clients detect gaps, repair via snapshot request. **Reconnect = fresh handshake + snapshot; there is no `resync` frame.**

**Idempotency:** submissions carry `client_msg_id`; `UNIQUE(round_id, client_msg_id)` replays return the original result. Double-taps safe.

## 6. Data Model (SQLite, WAL)

```sql
CREATE TABLE rooms      (code TEXT PRIMARY KEY, host_player_id TEXT, created_at INTEGER,
                         expires_at INTEGER, playback_mode TEXT DEFAULT 'manual');
CREATE TABLE players    (id TEXT PRIMARY KEY, room_code TEXT REFERENCES rooms, nickname TEXT NOT NULL,
                         token_hash TEXT, connected INTEGER DEFAULT 1, joined_at INTEGER);
CREATE UNIQUE INDEX idx_nick ON players(room_code, nickname COLLATE NOCASE) WHERE connected=1;
CREATE TABLE rounds     (id TEXT PRIMARY KEY, room_code TEXT, idx INTEGER, category TEXT,
                         scenario TEXT, state TEXT, phase_deadline INTEGER);
CREATE TABLE submissions(id TEXT PRIMARY KEY, round_id TEXT, player_id TEXT, track_id TEXT,
                         title TEXT, artist TEXT, client_msg_id TEXT, created_at INTEGER,
                         display_order INTEGER);           -- shuffled server-side
CREATE UNIQUE INDEX ux_sub_player ON submissions(round_id, player_id);
CREATE UNIQUE INDEX ux_sub_msg    ON submissions(round_id, client_msg_id);
CREATE TABLE results    (round_id TEXT, track_id TEXT, score INTEGER, rank INTEGER,
                         explanation TEXT, judge_model TEXT);
CREATE TABLE leaderboard_entries (room_code TEXT, player_id TEXT, points INTEGER, wins INTEGER);
```

DB constraints are the **final arbiter** for races: constraint violation → mapped to `23505`-style codes (`ALREADY_SUBMITTED`, `NAME_TAKEN`). Stage-1 Postgres swap keeps identical semantics (citext↔NOCASE, uuid↔TEXT ids).

## 7. MusicProvider Abstraction

```ts
interface MusicProvider {
  search(query: string, limit?: number): Promise<Track[]>;
  getTrack(id: string): Promise<Track>;
  authenticateHost(): Promise<AuthResult>;            // OAuth PKCE, server-side
  startPlayback(req: { uris: string[]; deviceId?: string; positionMs?: number }): Promise<void>;
  pause(): Promise<void>; resume(): Promise<void>; next(): Promise<void>;
  getActiveDevice(): Promise<Device | null>;
}
type ProviderError =
  | 'DEVICE_OFFLINE' | 'NOT_PREMIUM' | 'RATE_LIMITED' | 'TOKEN_EXPIRED'
  | 'TRACK_UNPLAYABLE' | 'NO_ACTIVE_DEVICE' | 'PROVIDER_DOWN';
```

- Lives in `src/core/`; Spotify impl quarantined in `src/providers/spotify/`. Engine imports the interface **only**. Tests use `FakeProvider`.
- **Spotify reality (Feb 2026 Dev Mode):** app capped at 5 allowlisted users — irrelevant here since only the host OAuths; owner Premium mandatory (lapse = outage; checklist item); search `limit≤10`; batch fetches removed; `/me` no longer exposes Premium status → cannot programmatically verify; previews presumed dead (day-one probe decides).
- **OAuth:** Authorization Code + PKCE server-side; refresh tokens encrypted at rest; proactive refresh at T-120s; `invalid_grant` → re-auth prompt.
- **Fallback ladder:** L0 full API autoplay → … → L4 **Manual** (app shows song cards; host plays on phone/Spotify app; taps Next; clock pauses between tracks — *first-class, tested*) → L5 silent (judge-only karaoke-text mode). Circuit breaker on 429 storms honoring `Retry-After`.
- Round orchestration: preload entire round queue in ONE `startPlayback` call; verify-don't-drive polling (5–10 s); device-loss grace window mid-round.

## 8. AI Judge

- **One batched LLM call per round**: all songs (shuffled, numbered) + scenario in a single prompt → comparative ranking is consistent by construction.
- Strict JSON-schema structured output: `judgements[{songIndex, score 0-100, explanation ≤2 sentences, rank}]`.
- Server-side semantic validation layer: ranks form permutation of 1..N; scores clamped; every submission covered; parser tolerant of fenced/prose JSON. Violations → retry.
- 3 retries exponential backoff, 20 s failsafe → **deterministic fallback judge** (hash-seeded, tagged `judge_model='fallback-hash'`) so an LLM outage never stalls a party.
- Cost control (single most important): **global LLM budget cap + provider spend cap**; judge triggered only on transition, never per-client.
- Prompt-injection surface: song titles/artists are untrusted input — sanitized/length-capped, rendered as data; explanation text rendered as text-only (no HTML sink).

## 9. Frontend

- **Vite + SolidJS + TypeScript**, multi-entry build: `host.html` (desktop/tablet) and `player.html` (phones, <90 kB gz). Route decides role, never screen size.
- **Screens (post-cut):** Landing · Host Lobby (55vh QR + giant code) · Phone Join (sticky CTA above keyboard) · Lobby · Song Search & Submit (search pinned top, sticky pick bar, two-step “SURE? 🔒” confirm, sealed state) · Locked/Waiting (peer-pressure submitted-list) · Host Playback (**API card + Manual card**; spacebar shortcuts) · **Reveal** · Leaderboard (FLIP row swaps) · Winner podium.
- Cut from earlier drafts: category-vote screen, READY toggle, emoji reactions, GSAP (CSS/WAAPI suffice).
- **Reveal choreography (beat-timed, 25–40 s):** drumroll → LAST PLACE slam (screen shake + sad trombone) → accelerating mid-ranks (tick pitch +2 semitones/rank) → TOP-2 freeze (blurred cards, heartbeat accel) → riser crescendo → white-flash winner explosion, crown drop, confetti ×3, winning chorus underlay (**gated on `playback_mode==='api'`**). WebAudio-synthesized SFX, haptics per beat, reduced-motion fallback, host long-press skip-to-winner, “Judge is thinking…” filler.
- **Realtime client:** one WS, 15 s heartbeat, backoff reconnect, gap detection via `seq`, full-snapshot replace-never-merge resync, `visibilitychange` socket lifecycle for phone lock screens. Optimistic UI restricted to cosmetic-only actions; lock-seal/reveal/leaderboard strictly server-authoritative.
- Fun rule kept: timer-expiry no-pick ⇒ AI assigns a random song and brands the player **CHICKEN 🐔**.
- Errors/disconnect copy centralized in `errors.ts`, personality-first.

## 10. Security Baseline (ships inside first vertical slice)

1. Unguessable session tokens on **every** message; role derived server-side (kills spoofing/host-forgery).
2. Server-side enforcement of all rules + CI negative tests (non-host commands rejected).
3. Input validation + caps (nickname ≤20 chars, titles ≤80); all LLM/UI text rendered as inert text.
4. Global LLM budget cap + provider spend cap.
5. Rate limits: room-create, join (per-IP + lockout), submissions, search proxy. In-memory.
6. Same-origin CORS; WS Origin check; **connect-ticket** instead of token-in-query-string.
7. Env-only secrets; PKCE; minimal Spotify scopes; encrypted token store.
8. Graceful judge degradation (rooms never hang on LLM).
Deferred (documented): WAF, distributed rate limiting, CSRF machinery, accounts/MFA — no ambient credentials by design. Residual worst case: one biased ranking + capped budget waste. Acceptable.

## 11. Testing

- **Unit (dominant):** table-driven FSM matrices incl. illegal transitions; judge prompt-build/parse; code-gen; timer arming. Property tests (fast-check): judgement permutation/coverage/clamps — **run against the fallback judge too**.
- **Integration (heavyweight):** real server + tmpfile SQLite + `FakeProvider` + `FakeLLM` (never real OpenAI/Spotify in CI). Hard cases as recipes with assertions: simultaneous submissions race, reconnect mid-reveal (state replay), host refresh mid-round (token reclaim + pause), duplicate nickname, late join mid-selection, room expiry with live sockets, **manual-mode round** (host-driven advance, paused clock, intact results), anonymity shuffle.
- **E2E (thin):** 2 Playwright flows, multi-context (1 host + 8 player contexts): happy-path smoke; host-refresh chaos.
- **Load:** k6 — 50 rooms × 8 players = playtest de-risk gate; 500×8 headroom variant; bursty submission windows; fan-out latency thresholds; churn/zombie-room variants.

## 12. Repository Layout

```
aux-battles/
  apps/server/src/  core/ fsm/ routes/ ws/ judge/ providers/ (spotify/, fake/)
  apps/web/         host/ player/ shared-ui/
  packages/shared/  src/events.ts schemas.ts constants.ts   ← @aux/shared (Zod, single protocol truth)
  docs/  (this doc + specialist docs, amended per §2 register)
  infra/ fly.toml Dockerfile
```

**Condition #2 satisfied:** `@aux/shared` exists before any client code; frontend types import it exclusively.

## 13. Milestones

| Phase | Scope | Gate |
|---|---|---|
| **0** | Repo scaffold, `@aux/shared`, CI, security 🔴 skeleton, docs amended per §2 | CI green |
| **1** | Landing, create room, QR, join, lobby | join <15 s on real phones |
| **2** | WS realtime, full FSM + timers, host controls, reconnect/reclaim | integration hard-case suite green |
| **2.5 SPIKE** | **Spotify preload-and-verify orchestrator behind `MusicProvider`**; day-one probes (preview_url, transfer latency, rate ceiling); **L0 and L4 both demo-able** | demo passes before any reveal polish |
| **3** | Anonymous submissions, round flow, shuffle anonymity | concurrency tests green |
| **4** | AI Judge (schema+validation+fallback), reveal choreography, leaderboard | judge property tests green; reveal feels great |
| **5** | Polish, k6 load gate, deploy (Fly.io single app + SQLite volume, WSS) | playtest party survived |

## 14. Non-Goals (MVP)

Microservices · Kubernetes · Kafka/queues · Redis · Postgres (until stage-1) · native apps · accounts/auth beyond session tokens · admin panels · category voting · READY toggles · reactions · preview clips (probe only) · delta-compression protocols · i18n.

## 15. Day-One Probes & Open Items

1. `preview_url` availability in Dev Mode (empirical; decides `getPreviewClip` fate).
2. Transfer-playback latency & reliability on real devices.
3. Observed rate-limit ceiling (calibrates polling cadence).
4. Host migration UX copy (needs product voice pass).

---

## Approval Gate

**APPROVED 2026-08-24.** Implementation proceeds from Phase 0 under the owner's twelve conditions, encoded as decisions D-008–D-014 in `DECISIONS.md`: living decision log · TASKS.md progress board · conventional-commit workflow · no anonymous TODOs (board-gated via `TODO.md`) · provider abstraction preserved · LLM behind config-swappable interface · dev-only debug dashboard · analytics event bus from day one · quality gates before every phase · UI philosophy (speed over spectacle) · Spotify spike stop-and-report gate · MVP feature freeze absent explicit owner request.
**Review conditions — all satisfied by design in this doc:** ✅ rulings applied (§2) · ✅ `@aux/shared` first (§12) · ✅ week-1 Spotify spike (§13 Ph 2.5) · ✅ security 🔴 in slice 1 (§10) · ✅ judge validation day one (§8, §11) · ✅ manual mode in definition-of-done (§7, §11).

## 16. Playtesting Loop

Success is measured by `PLAYTEST.md`, not by code shipped: structured sessions with the nine-question protocol begin after Phase 2 and gate Phase 5 completion. Engineering metrics from the analytics bus (D-010) cross-check felt experience; kill criteria there can pause all feature work. Answers to *"would people voluntarily play another round?"* outrank any further implementation.
