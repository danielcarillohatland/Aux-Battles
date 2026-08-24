# AUX BATTLES — Backend & API Specification (MVP)

**Stack decision: Node.js 20 + TypeScript, Fastify (REST) + `ws` (WebSocket), PostgreSQL (via Drizzle ORM), single process per region, Redis optional-but-skippable at MVP.**

Justification:
- The game is **I/O-bound and fan-out heavy** (hundreds of sockets pushing small JSON frames), not CPU-bound → Node's event loop is a natural fit; one process can host hundreds of rooms.
- **One language across client+server** → shared Zod schemas for REST bodies AND websocket messages, so protocol drift is impossible.
- **Server-authoritative FSM** means almost no long-running compute; Postgres alone handles "thousands of rooms later" easily (rooms are tiny rows). Redis is only added if we outgrow one node (see §9 scaling note).
- Fastify over Express: built-in JSON schema validation, faster, first-class TS types.
- Python alternative (FastAPI + websockets) is viable but loses the shared-schema win since the client is browser TS.

Process model: **one Node process = many rooms in memory + durable state in Postgres.** Rooms are hot-in-memory (FSM + timers) and persisted on every transition so a crash recovers cleanly.

---

## 1. Error envelope & conventions

Every non-2xx response, and every `error` WS frame, uses:

```jsonc
// HTTP
{ "ok": false, "error": { "code": "ROOM_NOT_FOUND", "message": "No room with code XK4TQ2", "details": { } }, "requestId": "req_01J8..." }
```

```jsonc
// WebSocket (server→client)
{ "t": "error", "code": "NOT_HOST", "message": "Only the host can do that", "ref": "clientMsgId-17" }
```

Error codes (stable enum, client switches on `code`, not message):

| Code | HTTP | Meaning |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Body/query failed schema |
| `ROOM_NOT_FOUND` | 404 | Bad room code |
| `PLAYER_NOT_FOUND` | 404 | Bad playerToken |
| `WRONG_PHASE` | 409 | Action not legal in current FSM state |
| `NAME_TAKEN` | 409 | Duplicate nickname in room |
| `ALREADY_SUBMITTED` | 409 | Player already has a song this round |
| `TOO_LATE` | 409 | Submission after lock |
| `NOT_HOST` | 403 | Host-only endpoint w/ player token |
| `RATE_LIMITED` | 429 | Per-token token bucket exceeded |
| `INTERNAL` | 500 | Unexpected |

Auth model: room-scoped tokens. `POST /rooms` returns a `hostToken`; joining returns a `playerToken` (random 128-bit, stored hashed? MVP: plaintext-at-rest acceptable, it's a party game — store as-is, expire with player). All requests carry `Authorization: Bearer <token>`; WS carries it in the query string (`ws://…/ws?room=XK4TQ2&token=…`). Tokens are single-audience: hostToken only works on `/host/*`.

---

## 2. REST endpoint inventory

Base: `https://api.auxbattles.game/v1`. All request/response bodies are validated by the same Zod schemas shared with the client (`@aux/shared`).

### 2.1 Room lifecycle

#### `POST /rooms` — create room (host)
```jsonc
// req
{ "nickname": "DJ Dad Jokes", "settings": { "rounds": 5, "selectionSeconds": 90, "playbackSeconds": 30, "explicitOk": true } }
// res 201
{
  "ok": true,
  "room": { "code": "XK4TQ2", "state": "LOBBY", "settings": { … } },
  "hostPlayerId": "pl_01J8…",
  "hostToken": "ht_9f2e…"        // shown ONLY here, never again
}
```

#### `POST /rooms/:code/join`
```jsonc
// req
{ "nickname": "Sam" }
// res 200
{ "ok": true, "playerId": "pl_01J8…", "playerToken": "pt_c81a…", "roster": [{ "playerId":"pl_…","nickname":"Sam","isHost":false,"connected":true }] }
```
Errors: `ROOM_NOT_FOUND`, `NAME_TAKEN`, `WRONG_PHASE` (joining mid-game allowed only in `LOBBY`; reconnect uses §2.6).

#### `GET /rooms/:code` — public room snapshot (poll fallback / pre-join screen)
→ `{ ok, room: { code, state, phaseEndsAt?, playerCount, scenario?: string|null, categories?: string[] } }` (no roster detail before join).

### 2.2 Categories & scenarios

#### `GET /categories` → `{ ok, categories: ["road trip","heartbreak","gym hype","villain era", …] }` (curated static list from DB).

Host picks during CATEGORY state:
#### `POST /host/category` (hostToken)
```jsonc
{ "category": "road trip" }   // res 202 { ok:true }; server draws a scenario, broadcasts SCENARIO
```

### 2.3 Submissions

#### `POST /rooms/:code/submissions` (playerToken)
```jsonc
// req — search-based pick, client hits our Spotify-search proxy then submits the track id
{ "trackId": "spotify:track:4uLU6hMCjMI75M1A2tKUQC",
  "title": "Fast Car", "artist": "Tracy Chapman", "durationMs": 297000,
  "clientMsgId": "cm_77b2" }          // idempotency key, see §5
// res 201
{ "ok": true, "submissionId": "sb_01J8…", "submittedCount": 4, "expectedCount": 6 }
```
Errors: `WRONG_PHASE` (must be SONG_SELECTION), `ALREADY_SUBMITTED`, `TOO_LATE`, `VALIDATION_ERROR`.

#### `GET /host/rooms/:code/submissions` (hostToken) — locked view, only after LOCKED:
→ `{ ok, submissions: [{ submissionId, title, artist, durationMs, order }] }` (no submitter identity until RESULTS reveal).

### 2.4 Host controls

| Endpoint | Body | Notes |
|---|---|---|
| `POST /host/start-game` | `{}` | LOBBY→CATEGORY |
| `POST /host/category` | `{ category }` | CATEGORY→SCENARIO |
| `POST /host/skip-submission-wait` | `{}` | jump SONG_SELECTION→LOCKED early |
| `POST /host/play-next` | `{}` | PLAYBACK: advance to next track / finish early |
| `POST /host/reveal-next` | `{}` | RESULTS: reveal next-worst (auto-advance also available) |
| `POST /host/next-round` | `{}` | LEADERBOARD→CATEGORY |
| `POST /host/end-game` | `{}` | any→GAME_OVER |
| `POST /host/kick` | `{ playerId }` | removes player, broadcasts |
| `PATCH /host/settings` | partial settings | LOBBY only |

All return `202 { ok:true }` unless they mutate state synchronously, in which case they return the new snapshot `{ ok:true, room:{…} }`. Illegal transitions → `WRONG_PHASE`.

### 2.5 Spotify proxy

#### `GET /search/tracks?q=fast%20car&limit=10` (any room token)
→ `{ ok, tracks: [{ trackId, title, artist, durationMs, albumArt }] }`
Server-side Spotify credentials (Client Credentials flow, cached token); rate-limited per player (10 req/min bucket) to protect quota. Client never sees Spotify keys.

### 2.6 Reconnect

#### `POST /rooms/:code/reclaim`
```jsonc
{ "nickname": "Sam" }   // same device lost its token
// res: 200 with fresh token IF nickname exists and is disconnected; 409 NAME_TAKEN if connected
```

---

## 3. Realtime message protocol (WebSocket)

Single WS endpoint `wss://api.auxbattles.game/v1/ws`. On connect: `?room=CODE&token=…`; server validates, attaches socket to room hub, and immediately sends a **`state_change` full snapshot** (so late joiners self-heal without REST polling).

Framing convention: every server frame has `"t"` (type) + `"ts"` (server unix ms) + `"seq"` (per-room monotonic counter — clients drop frames with `seq <= lastSeq` to survive reconnect gaps/duplicates). Every client frame may carry `"ref"` (clientMsgId) echoed back on errors/acks.

### 3.1 Server → ALL clients in room

```jsonc
// Full snapshot on join/reconnect/transition (authoritative; replaces local state)
{ "t":"state_change", "ts":1730000000000, "seq":42,
  "room": {
    "code":"XK4TQ2", "state":"SONG_SELECTION", "phaseEndsAt":1730000090000,
    "round": { "number":2, "of":5, "category":"road trip",
               "scenario":"You're driving away from a bank heist. One song on the radio.",
               "submissionCount":3 },
    "leaderboard": [ { "playerId":"pl_A", "nickname":"Sam", "totalScore":187, "wins":1 } ],
    "submissionsLocked": false
  },
  "you": { "playerId":"pl_B", "isHost":false, "hasSubmitted":true }   // per-recipient private slice
}
```
Note `state_change.you.hasSubmitted` differs per client — the frame is *typed* per recipient; the broadcast is one logical event fanned out with per-socket merge.

```jsonc
// Coarse countdown, every 1s while a phase timer runs (host renders big clock, players render small)
{ "t":"timer_tick", "ts":…, "seq":43,
  "phase":"SONG_SELECTION", "secondsRemaining":87, "phaseEndsAt":1730000090000 }

// Someone submitted (privacy-preserving count only, never WHO until reveal)
{ "t":"submission_received", "ts":…, "seq":44,
  "count":4, "total":6 }

// Phase timer expired server-side (clients also get this via state_change; explicit tick makes UI snappy)
{ "t":"phase_expired", "ts":…, "seq":45, "phase":"SONG_SELECTION" }
```

### 3.2 Server → HOST only

```jsonc
// Playback cue: host's Spotify should now play this track (host is the speaker system)
{ "t":"playback_cue", "ts":…, "seq":46,
  "order":2, "of":4,
  "track": { "trackId":"spotify:track:…", "title":"Fast Car", "artist":"Tracy Chapman", "durationMs":297000 },
  "previewOnly": false,           // true => play 30s preview via preview_url instead of full SDK playback
  "playMs":30000 }                // stop after this long

// Judgement streaming chunk (optional nicety): progressive explanations during AI_JUDGING
{ "t":"judge_progress", "ts":…, "seq":47, "done":2, "of":4 }
```

### 3.3 Server → ALL during RESULTS (reveal sequence)

```jsonc
// One frame per rank, worst→best, driven by host 'reveal-next' or auto-timer
{ "t":"judgement", "ts":…, "seq":48,
  "rank": 4, "of":4,                       // 4 = worst this round
  "score": 41,
  "explanation": "Choosing sea shanties for a heist getaway is a bold felony.",
  "submission": { "title":"…", "artist":"…" },
  "owner": { "playerId":"pl_C", "nickname":"Alex" }   // null until this final reveal frame
}
```
Reveal choreography: server sends `judgement` frames with `owner:null` for score+explanation first, then a final frame per rank adds owner — or simpler MVP: two frames per rank (`judgement` then `judgement.owner_revealed`). Keep `judgement` as above with owner included; the client animates owner separately using a `reveal_owner` frame:

```jsonc
{ "t":"reveal_owner", "ts":…, "seq":49, "rank":4, "playerId":"pl_C", "nickname":"Alex" }
```

### 3.4 Roster & lifecycle events

```jsonc
{ "t":"player_joined",  "ts":…, "seq":50, "player": { "playerId":"pl_D","nickname":"Riley","isHost":false } }
{ "t":"player_left",    "ts":…, "seq":51, "playerId":"pl_D", "reason":"disconnect"|"kicked" }
{ "t":"game_over",      "ts":…, "seq":52,
  "winner": { "playerId":"pl_A","nickname":"Sam" },
  "finalLeaderboard": [ …full ranked array… ] }
```

### 3.5 Client → Server (thin; most actions are REST)

WS is deliberately **read-mostly**: all mutations go through REST (validated, logged, idempotent). Only these ride WS for latency:
```jsonc
{ "t":"ping" }                                   // app-level keepalive every 15s; server replies { t:"pong", ts }
{ "t":"host_skip_wait" }                         // optional fast-path mirroring POST /host/skip-submission-wait
{ "t":"ack", "seq":48 }                          // client ack for judgement frames (enables resend buffer)
```

---

## 4. Database schema (PostgreSQL + Drizzle)

UUIDv7 primary keys (time-sortable). Money fields none; timestamps `timestamptz`.

```sql
CREATE TABLE rooms (
  id            uuid PRIMARY KEY,                 -- uuidv7
  code          char(5) NOT NULL UNIQUE,          -- see §7
  state         text NOT NULL DEFAULT 'LOBBY',    -- FSM enum (check constraint)
  settings      jsonb NOT NULL DEFAULT '{}',      -- { rounds, selectionSeconds, playbackSeconds, explicitOk }
  category      text,                             -- chosen for current round (denorm convenience)
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  closed_at     timestamptz                       -- set on GAME_OVER/cleanup
);
CREATE INDEX idx_rooms_state_created ON rooms (state, created_at);       -- janitor sweep
-- unique index on code IS the collision guard (§7)

CREATE TABLE players (
  id         uuid PRIMARY KEY,
  room_id    uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  nickname   citext NOT NULL,                   -- case-insensitive uniqueness below
  token      text NOT NULL,                     -- random url-safe; lookup index
  is_host    boolean NOT NULL DEFAULT false,
  connected  boolean NOT NULL DEFAULT true,
  joined_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_players_room_nick ON players (room_id, lower(nickname)) WHERE left_at IS NULL;
ALTER TABLE players ADD COLUMN left_at timestamptz;      -- soft-delete for kick/leave; keeps FK history
CREATE INDEX idx_players_room ON players (room_id);
CREATE UNIQUE INDEX uq_players_token ON players (token);

CREATE TABLE rounds (
  id         uuid PRIMARY KEY,
  room_id    uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  number     int  NOT NULL,
  category   text NOT NULL,
  scenario_id uuid REFERENCES scenarios(id),
  state      text NOT NULL DEFAULT 'SCENARIO',
  started_at timestamptz NOT NULL DEFAULT now(),
  locked_at  timestamptz,
  UNIQUE (room_id, number)
);

CREATE TABLE scenarios (
  id        uuid PRIMARY KEY,
  category  text NOT NULL,
  body      text NOT NULL,                     -- "You're driving away from a bank heist…"
  active    boolean NOT NULL DEFAULT true
);
CREATE INDEX idx_scenarios_cat ON scenarios (category) WHERE active;

CREATE TABLE submissions (
  id         uuid PRIMARY KEY,
  round_id   uuid NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  player_id  uuid NOT NULL REFERENCES players(id),
  track_id   text NOT NULL,                    -- spotify track uri/id
  title      text NOT NULL,
  artist     text NOT NULL,
  duration_ms int NOT NULL,
  client_msg_id text NOT NULL,                 -- idempotency key
  play_order smallint,                         -- assigned at lock time (shuffle); null until LOCKED
  submitted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (round_id, player_id),                -- ONE song per player per round (DB-enforced)
  UNIQUE (round_id, client_msg_id)             -- idempotent retry (§5)
);
CREATE INDEX idx_subs_round ON submissions (round_id);

CREATE TABLE results (
  id            uuid PRIMARY KEY,
  round_id      uuid NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  submission_id uuid NOT NULL UNIQUE REFERENCES submissions(id),
  score         smallint NOT NULL CHECK (score BETWEEN 0 AND 100),
  explanation   text NOT NULL,
  rank          smallint NOT NULL,             -- 1 = best, N = worst
  judge_model   text NOT NULL,                 -- e.g. 'gemini-2.0-flash' — provenance for debugging
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (round_id, rank)
);

CREATE TABLE leaderboard_entries (              -- materialized cumulative view, updated per round
  room_id   uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  player_id uuid NOT NULL REFERENCES players(id),
  total_score int NOT NULL DEFAULT 0,
  rounds_played int NOT NULL DEFAULT 0,
  wins int NOT NULL DEFAULT 0,                 -- # rounds where rank=1
  PRIMARY KEY (room_id, player_id)
);
```

Notes:
- `citext` + functional unique index gives case-insensitive nicknames ("sam" vs "Sam").
- `UNIQUE(round_id, player_id)` makes double-submission impossible even under a race — the DB is the final arbiter (§5).
- Hot path writes are tiny: one row insert per submission, one transition UPDATE per phase. Postgres barely notices hundreds of concurrent rooms.

---

## 5. Concurrency handling

Principles: **the FSM lives in memory per-room behind an async mutex; the DB constraints are the backstop; clients send idempotency keys.**

**(a) Simultaneous submissions.** Two inserts race → both hit `INSERT`; second violates `UNIQUE(round_id, player_id)` → catch `23505` and return `ALREADY_SUBMITTED`. No read-modify-write anywhere:

```ts
const [row] = await db.insert(submissions)
  .values({ roundId, playerId, ...body, clientMsgId })
  .onConflictDoNothing({ target: [submissions.roundId, submissions.playerId] })
  .returning();
if (!row) throw new ApiError(409, 'ALREADY_SUBMITTED');
roomHub.broadcast(roomCode, { t: 'submission_received', count: await countSubs(roundId), total });
if (await countSubs(roundId) === expectedActivePlayers()) fsm.tryTransition('LOCKED'); // auto-lock
```

**(b) Duplicate nicknames.** Same pattern against `uq_players_room_nick` → `23505` → `NAME_TAKEN`. Case handled by `lower()` index + citext.

**(c) Double-taps / retries.** Every mutating client call carries `clientMsgId`. Server keeps `(round_id, client_msg_id)` unique — a retry returns the *original* result (idempotent):

```ts
const existing = await db.query.submissions.findFirst({
  where: and(eq(submissions.roundId, r), eq(submissions.clientMsgId, msgId)),
});
if (existing) return { ok: true, submissionId: existing.id, replayed: true }; // 200 not 201
```

**(d) Per-room serialization.** State transitions must be atomic relative to each other (e.g., timer expiry vs host skip both try LOBBY→next). Each room object owns an async mutex:

```ts
class Room {
  private mutex = chain();                      // promise-chain queue
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.mutex.then(fn, fn);        // serialize regardless of prior failure
    this.mutex = run.catch(() => {});
    return run;
  }
}
// every mutation entry point: room.run(() => fsm.dispatch(event))
```

In-process is enough at MVP (one process owns a room; room→process routing later via sticky sessions or a Redis pubsub fanout — see §9).

**(e) Rate limiting.** Token bucket per playerToken: 20 mutations/min, 10 search calls/min. Cheap in-memory map; protects Spotify quota and judges.

---

## 6. FSM implementation

**Hand-rolled, table-driven — ~80 lines, no library.** Reasons: the graph is a simple cycle with a few skips; libraries (xstate/zombienet etc.) pull in weight and their visual tooling isn't needed; a literal adjacency table is auditable and testable. (If states multiply later, port to xstate — the dispatch surface below maps 1:1.)

```ts
// fsm.ts
export type GameState =
  | 'LOBBY' | 'CATEGORY' | 'SCENARIO' | 'SONG_SELECTION'
  | 'LOCKED' | 'PLAYBACK' | 'AI_JUDGING' | 'RESULTS'
  | 'LEADERBOARD' | 'GAME_OVER';

const TRANSITIONS: Record<GameState, Partial<Record<GameEvent, GameState>>> = {
  LOBBY:           { START_GAME: 'CATEGORY' },
  CATEGORY:        { PICK_CATEGORY: 'SCENARIO' },
  SCENARIO:        { OPEN_SELECTION: 'SONG_SELECTION' },   // auto after short scenario display
  SONG_SELECTION:  { ALL_SUBMITTED: 'LOCKED', SKIP_WAIT: 'LOCKED', TIMER_EXPIRED: 'LOCKED' },
  LOCKED:          { BEGIN_PLAYBACK: 'PLAYBACK' },         // brief shuffle beat
  PLAYBACK:        { NEXT_TRACK: 'PLAYBACK', DONE_PLAYING: 'AI_JUDGING' },
  AI_JUDGING:      { JUDGEMENT_READY: 'RESULTS' },         // also FAILSAFE_TIMEOUT -> 'RESULTS'
  RESULTS:         { NEXT_ROUND: 'LEADERBOARD' },          // after final reveal
  LEADERBOARD:     { ADVANCE: 'CATEGORY', END_GAME: 'GAME_OVER' },
  GAME_OVER:       {},
};

export class RoomFsm {
  constructor(private state: GameState, private onChange: (from: GameState, to: GameState, ev: GameEvent) => void) {}
  can(ev: GameEvent) { return !!TRANSITIONS[this.state][ev]; }
  dispatch(ev: GameEvent): GameState {
    const next = TRANSITIONS[this.state]?.[ev];
    if (!next) throw new ApiError(409, 'WRONG_PHASE', `${ev} illegal in ${this.state}`);
    const from = this.state; this.state = next;
    this.onChange(from, next, ev);              // persist room.state + broadcast state_change
    return next;
  }
}
```

Side-effects live in the `onChange` hook (persist → broadcast → arm/cancel timers → kick off judge job), keeping the machine pure and unit-testable. Crash recovery on boot: for every room row with `closed_at IS NULL`, reload state, re-arm the phase timer from `phase_deadline` column (see §6.1), resume PLAYBACK position from `results`-pending queue.

**Timers (§6 merged topic — who owns countdowns, drift):**
- The **server is the sole clock authority**. Clients render from `phaseEndsAt` (absolute epoch ms) synced via `timer_tick`; they never decide phase end locally.
- One `setTimeout` per room phase, stored in a `Map<roomId, NodeJS.Timeout>`, canceled on any transition. On expiry the callback goes through the same mutex + FSM (`TIMER_EXPIRED`), so expiry-vs-host-skip races resolve serially and the loser gets a benign `WRONG_PHASE`.
- Drift: `timer_tick.secondsRemaining` is computed as `Math.ceil((deadline - Date.now())/1000)` at send time, and ticks are sent at whole-second boundaries computed from deadline (not from setTimeout jitter): schedule next tick at `deadline - n*1000`. A 250ms `setTimeout` overshoot guard (`unref()`, re-check deadline inside callback) prevents early/late fire issues. If server time jumps (NTP), ticks self-correct because everything derives from the absolute deadline.
- Persistence: `rooms.phase_deadline timestamptz` written on each timed transition → process restart recomputes remaining time; already-expired deadlines fire immediately on recovery.

```ts
armPhaseTimer(room, ms) {
  clearTimeout(this.timers.get(room.id));
  const deadline = Date.now() + ms;
  room.phaseDeadline = new Date(deadline);                       // persisted
  this.timers.set(room.id, setTimeout(async () => {
    this.timers.delete(room.id);
    await room.run(() => { if (room.fsm.can('TIMER_EXPIRED')) room.fsm.dispatch('TIMER_EXPIRED'); });
  }, ms + 25));                                                  // +25ms guard so tick(n=0) sends first
}
```

---

## 7. Room code generation & collision

Format: **5 chars from an unambiguous alphabet** `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (31 chars — no I/L/O/0/1; QR + shouting-across-the-room safe). Keyspace ≈ 31⁵ ≈ 28.6M — ample for thousands of live rooms.

Strategy: **rejection insert with retry loop**, leaning on the DB unique index as truth:

```ts
export function newRoomCode(): string {
  let s = '';
  for (let i = 0; i < 5; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return s;
}
async function createRoom(...) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = newRoomCode();
    try { return await db.insert(rooms).values({ ...vals, code }).returning(); }
    catch (e: any) { if (e.code !== '23505') throw e; }        // collision -> retry
  }
  throw new Error('code entropy exhausted');                   // practically unreachable
}
```

Lifecycle: codes of closed rooms stay reserved for 24h (prevents "join the corpse"), then a janitor sets `closed_at` and a nightly job frees them (unique index is partial: `WHERE closed_at IS NULL OR closed_at > now()-interval '24 hours'` — or simplest: hard-delete rooms older than 24h along with cascade children).

---

## 8. AI Judge integration

Point in FSM: `DONE_PLAYING` fires → server gathers all round submissions → **one LLM call for the entire round** (all songs batched — cheaper, and crucially lets the model produce *consistent comparative ranks*, which per-song calls cannot). While waiting, state = `AI_JUDGING` (broadcast `judge_progress` heartbeat every 2s). Hard failsafe timer (20s): if no result, fall back (below) and transition anyway — the show must go on.

Request shape (OpenAI-compatible chat completion, structured output):

```jsonc
{
  "model": "<configured-judge-model>",
  "temperature": 0.9,
  "response_format": { "type": "json_schema", "json_schema": { "name": "judgement", "strict": true, "schema": JudgeSchema } },
  "messages": [
    { "role": "system", "content":
      "You are the AUX BATTLES judge: a hilariously ruthless music critic. Score each song 0-100 for fit to the scenario (fit dominates; quality/vibes tiebreak). Explanations: max 140 chars, one sharp joke, roast the worst hardest, no slur/profanity. Rank strictly by score, no ties." },
    { "role": "user", "content": "SCENARIO: You're driving away from a bank heist.\n\nSONGS:\n1. \"Fast Car\" — Tracy Chapman\n2. \"Sandstorm\" — Darude\n3. \"My Heart Will Go On\" — Céline Dion\n\nReturn judgements for every song." }
  ]
}
```

Structured output schema (`JudgeSchema`) — mirrors the `results` table:

```jsonc
{
  "type": "object", "additionalProperties": false, "required": ["judgements"],
  "properties": {
    "judgements": {
      "type": "array", "items": {
        "type": "object", "additionalProperties": false,
        "required": ["songIndex", "score", "explanation", "rank"],
        "properties": {
          "songIndex":  { "type": "integer", "minimum": 1 },   // matches numbered list in prompt
          "score":      { "type": "integer", "minimum": 0, "maximum": 100 },
          "explanation":{ "type": "string", "maxLength": 140 },
          "rank":       { "type": "integer", "minimum": 1 }    // 1 = best
        }
      }
    }
  }
}
```

Server-side validation & repair pipeline:

```ts
async function judgeRound(round: Round, subs: Submission[]): Promise<Result[]> {
  const numbered = subs.map((s, i) => `${i + 1}. "${s.title}" — ${s.artist}`).join('\n');
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const raw = await llm.complete(judgePrompt(round.scenario, numbered), /* schema */ JudgeSchema, { timeoutMs: 15000 });
      const j = validateAndRepair(raw, subs.length);
      // validateAndRepair: exactly N items; songIndex covers 1..N bijectively;
      // ranks are a permutation of 1..N (else derive ranks from score sort);
      // scores clamped to 0..100; explanations trimmed to 140 chars.
      if (j) return persistResults(round.id, subs, j);
    } catch (e) { log.warn('judge attempt failed', { attempt, e }); await sleep(500 * 2 ** attempt); }
  }
  return fallbackJudge(round.id, subs);   // deterministic fallback, game continues
}

function fallbackJudge(roundId: UUID, subs: Submission[]): Result[] {
  // Deterministic pseudo-scores seeded by hash(trackId+scenario): 55±15, shuffled-ish ranks.
  // Explanation template pool: "The scenario said HEIST, not HEIST-ADJACENT." etc.
  // Marked judge_model='fallback-hash' in results so ops can measure LLM outage rate.
}
```

Fallback guarantees: identical output shape, ranks still 1..N (reveal choreography unchanged), never blocks the FSM longer than the failsafe.

---

## 9. Scaling note (post-MVP)

Current design supports thousands of rooms on one beefy node (each idle room is ~1KB heap + zero timers; active rooms ≤ 2 timeouts). When one node saturates: shard rooms across processes behind a sticky load balancer (route by room code prefix), swap the in-process hub's broadcast for Redis pub/sub, and move rate-limit buckets to Redis. Nothing in the API contract changes.
