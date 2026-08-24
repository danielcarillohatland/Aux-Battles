# AUX BATTLES — System Architecture Blueprint (MVP)

## 1. Overall topology: ONE service, one process

**Decision:** A single stateful Node.js service exposing both HTTP API and realtime channel. No split into "game service" + "realtime gateway" + "judge worker" for MVP.

**Why:**
- The game's entire value is low-latency shared state inside a room. Splitting the FSM from the realtime layer forces you to invent inter-service sync (pub/sub, sticky routing) on day one — pure overhead at MVP scale.
- One process = the room state lives in memory next to the sockets that read it. No cache-invalidation problem exists because there is nothing to invalidate.
- Single deployable, single log stream, single failure domain. You can debug the whole system by reading one process.
- The brief bans microservices/Kafka/K8s; a split topology is that ban in disguise.

**Shape:** `Node.js (Fastify or Express) + ws` — one process serving:
- REST endpoints for idempotent/request-response actions (create room, join, submit song)
- WebSocket connection per client for server-pushed state
- In-process room registry (`Map<roomCode, Room>`)
- AI judge calls fired as async tasks *within* the same process

## 2. Finite State Machine

### States (per ROOM, not per player)

```
LOBBY → CATEGORY → SCENARIO → SONG_SELECTION → LOCKED
      → PLAYBACK → AI_JUDGING → RESULTS → LEADERBOARD
      → (loop: CATEGORY) … or GAME_OVER
```

Notes:
- **CATEGORY**: host picks/rotates the category for the round (or auto-shuffle).
- **SCENARIO**: server generates/fetches scenario text, broadcasts it. Short timed state.
- **LOCKED**: submissions closed; host sees "ready to play"; brief staging state before playback starts. Prevents a race where someone submits while playback begins.
- **LEADERBOARD** vs **RESULTS**: RESULTS = per-song reveal (worst→best count-up). LEADERBOARD = cumulative standings after reveal. Host advances LEADERBOARD→CATEGORY (next round) or →GAME_OVER (end game).

### Transition triggers — who fires what

| Transition | Trigger | Who |
|---|---|---|
| LOBBY→CATEGORY | host presses Start (min 2 players enforced) | host action |
| CATEGORY→SCENARIO | host picks category **or** 30s timer | host action w/ timer fallback |
| SCENARIO→SONG_SELECTION | fixed timer (~5s to read scenario), auto | server timer |
| SONG_SELECTION→LOCKED | all connected players submitted **or** timer (90s default, host-configurable) | server: whichever first |
| LOCKED→PLAYBACK | host presses Play | host action |
| PLAYBACK→AI_JUDGING | all songs played **or** host hits Next/Skip past last track | host action / server |
| AI_JUDGING→RESULTS | judge results complete & persisted | server (task callback) |
| RESULTS→LEADERBOARD | reveal animation finished — host clicks through each reveal step; final step auto-advances | host action |
| LEADERBOARD→CATEGORY | host presses Next Round (or round-limit reached → GAME_OVER) | host action |
| any→GAME_OVER | host ends game, or round limit hit, or room empty > TTL | host/server |

**Rule: timers never advance states that require content the host controls (PLAYBACK needs host present at speakers). Timers DO advance pure-timeout states (SCENARIO, SONG_SELECTION) so AFK players can't stall the room.**

Timer implementation: NOT `setTimeout` per state. Each room stores `phase_deadline` (epoch ms); a single coarse ticker (every 1s) scans rooms and fires due transitions. This survives restarts (deadline is persisted with state) and avoids thousands of live timers.

### Crash recovery

Every transition writes `{version, phase, phase_deadline, round_no}` to durable storage **before** broadcasting (write-ahead). On process restart:

1. Rooms reload lazily: first WS message or HTTP request naming room X hydrates it from disk/DB.
2. If `now > phase_deadline`, run the due transition(s) immediately (catch-up loop until state is deadline-consistent).
3. Clients reconnect (see §7); their first message triggers hydration. Room appears dead only if nobody asks about it — which means nobody cares.

Edge case: crash during PLAYBACK means Spotify playback died too. On recovery into PLAYBACK, transition to AI_JUDGING for songs already played and re-offer remaining tracks, OR simpler MVP rule: **crash mid-playback → skip to AI_JUDGING of all submitted songs**. Choose the simple rule; document it.

## 3. Realtime transport: WebSocket (server-push), one socket per client

**Decision:** WebSocket. Rejected SSE and polling.

**Why WS over SSE:**
- The client→server path matters: submits, buzzes, host controls, heartbeats. SSE forces those onto separate fetch/XHR calls, splitting your protocol in two (socket + REST) with two auth/session mechanisms and doubled reconnect logic. WS gives one bidirectional channel, one session concept.
- Polling fails outright: PLAYBACK/AI_JUDGING need push latency <300ms for the reveal drama; polling at that latency × thousands of clients is wasted load, and at sane intervals (3–5s) the party-game feel dies.
- SSE's only real advantages (auto-reconnect, proxy-friendliness) are cheap to reimplement on WS (heartbeat + resume, see §7).

**Protocol sketch:** JSON envelopes `{type, seq, payload}`. Server pushes full room-state snapshots on change (rooms are small — a snapshot is a few KB; do NOT do fine-grained patches at MVP). Client sends typed actions; every action is validated server-side against current phase (e.g., `submit_song` rejected unless phase=SONG_SELECTION).

Heartbeat: ping/pong every 15s; no pong ×2 → mark player disconnected (not eliminated).

## 4. Room lifecycle

- **Creation:** host POST `/rooms {settings}` → server generates a **4-letter code from a curated alphabet (no 0/O, 1/I/L)**, collision-checked against active rooms. 4 letters = 40^4 ≈ 2.56M codes; at even 100k concurrent rooms collision retries are trivially cheap.
- **Joining:** join page encodes code in URL (`/j/ABCD`) via QR. Player sends nickname → server returns `playerId` (UUID) + short-lived signed token used on the WS handshake. Nicknames are unique-per-room (append suffix on dupe).
- **Expiration/cleanup:**
  - Room TTL rules: empty (no connected players) for **10 min** → evicted; hard cap **6h** regardless.
  - Sweeper runs in the same 1s tick (check every ~60s): disconnects stale players, evicts dead rooms, persists final leaderboard before eviction.
  - If host disconnects: **host migration** — promote the longest-connected player, notify room. Party games die when the host's laptop sleeps; this is a must-have, not nice-to-have.
  - If room drops below 2 players mid-game → pause in LOBBY-like waiting state rather than ending.

## 5. State persistence strategy

Three tiers, deliberately boring:

1. **Authoritative hot state: in-process memory** (`Map<code, Room>`). All reads/writes go through the FSM; single-threaded event loop = no locks needed. This is THE reason for the single-service topology.
2. **Durable checkpoint: SQLite (WAL mode) on disk**, written on every phase transition + every submission (submissions are user-generated content; losing them to a crash is unacceptable). Schema ≈ `rooms(room_code, json_state, version, updated_at)` + `songs(room_code, round, player_id, track_json)` — document-style blob for room state, relational for songs. SQLite because: zero ops, single-file backup, and it already enforces the write-ahead discipline we need for recovery. Postgres later if needed; the persistence module is one interface (`RoomStore.get/put/delete`).
3. **Ephemeral: nothing else.** No Redis, no message bus.

Write volume sanity check: worst realistic MVP load, ~500 active rooms × ~1 write/sec aggregate = trivial for SQLite WAL.

## 6. Join edge cases (all decided SERVER-SIDE, keyed on playerId not socket)

- **Duplicate join (same playerId):** new WS connection replaces old; old socket is closed by server with `{type:'superseded'}`. Same nickname+device rejoin = reuse existing player row.
- **Nickname collision:** server appends `#2`, `#3`. Never trust the client.
- **Reconnect (mid-round):** player reconnects with stored token within **120s** → restored with full state snapshot + their submission status. Their anonymous submission survives (stored under their playerId). After 120s they may rejoin as themselves but miss the current round (marked `absent`; score unaffected).
- **Late join:** allowed only in LOBBY, RESULTS, LEADERBOARD, GAME_OVER. During SONG_SELECTION they may join and still submit (grace: if >50% of round time remains). During LOCKED/PLAYBACK/AI_JUDGING they sit in a "waiting room" overlay and enter at the next phase boundary. Never let late joins mutate a locked competitive state.
- **Anonymous submissions:** server shuffles submission order before playback/judging so neither host UI nor timing leaks ownership. Owner mapping lives only in server memory until reveal.

## 7. AI judging invocation: async task INSIDE the FSM process

**Decision:** fire-and-await async call within the same Node process — `AI_JUDGING` phase sets `judging_task = judgeAsync(submissions)`, FSM awaits its promise (with timeout), then transitions.

- **Not sync/blocking:** LLM latency (2–10s, sometimes 30s) would freeze the event loop's other rooms if awaited naively — it isn't blocking anyway in Node, but more importantly the phase must be interruptible and retryable.
- **Not a separate worker/service yet:** a queue+worker buys crash-isolation of judge jobs, but costs deployment complexity. Instead: judge job is a **persisted pending-job record** (`jobs(room_code, round, status)`). On crash-recovery, unfinished jobs are retried once; on second failure the room degrades gracefully (**fallback scorer**: deterministic pseudo-random score + canned quip) so a party never hard-blocks on OpenAI/Anthropic being down.
- Concurrency guard: cap in-flight judge calls (e.g., p-limit 20); per-room single-flight so double-transitions can't double-bill.
- Prompt context: category + scenario + list of track metadata (title/artist). Scores normalized to 0–100; explanation ≤2 sentences enforced by prompt + validation regex/retry.

## 8. Scaling path (10 → thousands of rooms) without over-engineering now

The architecture is chosen so scaling is *additive*, not *rewrite*:

| Stage | Rooms | What changes |
|---|---|---|
| 0 (MVP) | 10–100s | Single process, SQLite. Done. |
| 1 | ~1–5k | Run N identical processes behind a load balancer; **route by room code** (consistent hash on code, e.g., sticky at LB or a tiny code→node lookup in Redis). Each room lives entirely on one node — no distributed FSM ever. SQLite → Postgres shared store. Judge jobs move to a simple queue table polled by any node (Postgres `FOR UPDATE SKIP LOCKED`). |
| 2 | 10k+ | Extract judge worker pool; add Redis pub/sub ONLY for cross-node admin/broadcast needs (rare); horizontal node adds stay linear. |

Key property enabling this: **all state and all sockets for a room co-locate on one node**. We never need cross-node consensus on game state. The MusicProvider and RoomStore interfaces (§10, §5) are the seams that make stage 1 a config change, not surgery.

Explicitly deferred: Redis, Kafka, K8s, gRPC, sharding, read replicas. None needed until stage 1 metrics say so.

## 9. Deployment topology (MVP)

- **One VPS or one small cloud VM** (2–4 vCPU, 4–8GB): Node service behind Caddy/nginx (TLS termination + static hosting of the web client).
- Web client: static bundle served by same box (or Cloudflare Pages/Netlify free tier — even simpler, decouples client deploys).
- SQLite file on persistent volume; nightly copy to object storage.
- Process supervision: systemd + `--max-old-space-size` sane limit; health endpoint `/healthz`.
- DNS + TLS via Let's Encrypt. QR codes generated client-side from join URL.
- Total moving parts: VM, Node process, reverse proxy, SQLite file. Nothing else.

## 10. MusicProvider abstraction seam

```ts
// src/core/music-provider.ts  — core NEVER imports anything spotify-*
interface MusicProvider {
  search(query: string, opts?: {limit?: number}): Promise<Track[]>;
  getTrack(id: string): Promise<Track>;
  play(deviceId?: string): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  next(): Promise<void>;
  // auth handled inside provider impl; core sees only errors
}
interface Track {
  id: string; title: string; artist: string;
  durationMs: number; artworkUrl?: string; previewUrl?: string;
}

// src/providers/spotify.ts implements MusicProvider via Spotify Web API
```

- **Dependency injection:** composition root in `src/main.ts` builds `SpotifyProvider` (token refresh, device management) and hands it to the `GameEngine` constructor. Engine depends on the interface only; unit tests inject `FakeMusicProvider` (scriptable latencies, failures).
- Playback model: provider drives the **host's device** (Spotify Connect `transfer`/play). Provider owns ALL Spotify quirks: OAuth refresh, 409 "already playing", rate limits (internal token bucket), device-lag retries. Core just awaits `provider.play()` and treats failures as a `PlaybackError` the FSM surfaces to the host UI.
- Search happens **client-side via server proxy** → `POST /rooms/:code/search?q=` routes through the room's provider instance; results cached per-room for the round (reduces API calls, keeps anonymity uniform).
- Swap cost for "prototype-only": replacing Spotify later = new file implementing 7 methods. Zero engine changes.

## 11. Component diagram (text)

```
                         ┌──────────────────────────────────────────────┐
   Phones (players)      │            SINGLE NODE SERVICE               │     Host desktop/tablet
 ┌───────────┐    WSS    │  ┌────────────┐      ┌─────────────────────┐  │    ┌───────────┐
 │ Web client├◄──────────┼─►│ Gateway /  │◄────►│   GameEngine (FSM)  │◄─┼───►│ Web client│
 │ (join,    │    WSS    │  │ WS hub     │      │  - room registry    │  │    │ (host UI, │
 │  search,  ├◄──────────┼─►│ - sessions │      │  - 1s ticker/timers │  │    │  playback │
 │  submit)  │           │  │ - snapshot │      │  - transitions      │  │    │  control) │
 └─────┬─────┘           │  │   push     │      └───────┬─────────────┘  │    └─────┬─────┘
       │ HTTPS           │  └────────────┘              │ ctor-injected  │          │ HTTPS
       │  search/submit  │                              ▼                │          │
       └────────────────►│  ┌────────────┐   ┌──────────────────┐        │          │
                         │  │ REST API   │   │ MusicProvider IF │        │          │
                         │  │ (idempotent│   │  ┌──────────────┐│        │          │
                         │  │  actions)  │   │  │SpotifyProvider│───────┼──────────┘
                         │  └────────────┘   │  └──────────────┘│        │   Spotify Web API
                         │                   └──────────────────┘        │   (host device)
                         │  ┌────────────┐   ┌──────────────────┐        │
                         │  │ RoomStore  │   │ JudgeService     │───────┼──► LLM API (async,
                         │  │ (SQLite    │   │ (persisted jobs, │        │    capped, fallback
                         │  │  WAL)      │   │  retry+fallback) │        │    scorer on fail)
                         │  └────────────┘   └──────────────────┘        │
                         └──────────────────────────────────────────────┘
```

Static web client is served separately (CDN/static hosting) — it is not part of the service.

## 12. Data flow — one round (happy path)

1. **LOBBY:** Host creates room `QRXZ` (POST /rooms). 6 phones scan QR → join with nicknames → WS connects, receive snapshot.
2. **CATEGORY:** Host taps "Movie villain entrances". Server broadcasts phase=CATEGORY w/ options; host selects; timer fallback armed.
3. **SCENARIO:** Server generates scenario text ("villain entrance at a kids birthday party") → broadcast; 5s read timer.
4. **SONG_SELECTION:** Broadcast phase+deadline. Each phone opens search sheet → `POST /search` proxies provider → player submits ONE track → `POST /submit` validates phase, stores under playerId, acks. Push updates show "4/6 locked in".
5. **LOCKED:** Last submission (or 90s timer) closes round. Submissions shuffled server-side. Host sees "Ready — 6 songs".
6. **PLAYBACK:** Host presses Play → engine calls `musicProvider.play(track_i)` on host's Spotify device → broadcast "Now playing #i". Host taps Next between tracks (or 30s auto-skip).
7. **AI_JUDGING:** Engine persists judge job → calls LLM with [scenario + 6 track metadatas] (single batched call) → parses scores/quips → persists → phase=RESULTS. (Fallback scorer if LLM fails.)
8. **RESULTS:** Server reveals entries one-by-one worst→best on host click: score count-up + quip + owner reveal. Each reveal is a pushed event; phones mirror.
9. **LEADERBOARD:** Cumulative scores broadcast. Host: "Next round" → CATEGORY (round 2) … or "End game" → GAME_OVER (winner podium, share card).

## 13. Explicit NOT doing (MVP)

- ❌ Microservices, message queues (Kafka/RabbitMQ), Kubernetes, Docker swarm choreography
- ❌ Redis / external cache layer (SQLite + memory suffices)
- ❌ Native mobile apps; PWA-lite web only
- ❌ User accounts, OAuth login, passwords — nickname + ephemeral token only
- ❌ Admin panel / moderation tooling
- ❌ Fine-grained state deltas (patch/diff protocol) — full snapshots
- ❌ Multi-node game state, distributed FSM, sticky-session infra beyond LB hashing
- ❌ Separate judge microservice / external job runner
- ❌ Audio streaming through our servers (Spotify plays on host device; we send commands, never audio)
- ❌ Chat / voice / reactions beyond emoji preset (if even that)
- ❌ Replay/recording of rounds, analytics pipeline
- ❌ Custom music sources beyond provider seam (YouTube etc. post-MVP via same interface)
- ❌ Anti-cheat beyond server authority (song-choice "cheating" isn't really preventable or harmful here)

## 14. Architectural risks

| Risk | Severity | Mitigation |
|---|---|---|
| **Spotify device playback latency/unreliability** (Connect can lag 1–5s, randomly pauses, Premium-only) | HIGH — it's the core experience | Provider wraps retries/timeouts; host UI shows explicit "playing on…" status + manual Next; graceful "Spotify hiccup, replay track" affordance; never auto-chain tracks blindly. This is the #1 product risk, not infra. |
| **LLM latency/outage stalls AI_JUDGING** | MED-HIGH | Hard timeout (e.g., 20s) → fallback deterministic scorer; persisted job retried once; party never blocks >20s. |
| **Single process = single point of failure; deploy restarts kick everyone** | MED | Write-ahead checkpoints + lazy hydration + auto-reconnect make restarts a ~5s blip; deploy during LOBBY-heavy periods; systemd auto-restart. Accept residual risk at MVP scale. |
| **Node event-loop contention** (hundreds of rooms × 1s tick + WS fan-out) | MED | Ticker is O(rooms) cheap scan; snapshot pushes batched per phase-change not per keystroke; monitor loop-lag; stage-1 plan (§8) is the pressure valve. |
| **Host migration bugs** (two hosts, orphaned playback) | MED | Migration is a normal FSM event emitting a single `host_changed` broadcast; old host socket superseded like duplicate joins. Test explicitly. |
| **Anonymity leak via timing/order** | LOW-MED | Shuffle before persisting playback order; uniform ack times; owner map server-only. |
| **Room-code collisions/guessing** | LOW | Curated 4-letter alphabet + active-set uniqueness; rate-limit join attempts per IP. |
| **SQLite write contention under burst** (everyone submits in final seconds) | LOW | WAL handles bursts of this size; submissions are small; stage-1 swaps in Postgres behind same interface. |

— End of blueprint —
