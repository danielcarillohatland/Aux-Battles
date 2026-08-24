# AUX BATTLES — Testing Strategy (MVP)

Realtime multiplayer FSM party game. Server-authoritative, websockets, no accounts, must survive a real playtest with 8–15 people on flaky wifi. This strategy optimizes for **fast iteration** while catching the failure classes that actually kill party games: state desync, stuck rooms, and crashes mid-reveal.

---

## 1. Test Pyramid, Adapted

A realtime FSM game inverts part of the classic pyramid: the *interesting* logic lives in transitions and message handling, not pure functions — so integration tests earn more weight than usual. Recommended shape:

```
        /  e2e: 1 smoke flow + 1 chaos flow   \      (~5 tests, Playwright)
       /   integration: room flows vs real    \     (~30-50 tests, Testcontainers)
      /    server + DB + fake LLM/Spotify      \
     /  unit: FSM transitions, judge parsing,   \   (~100+ tests, pure, ms-fast)
    /   scoring math, nickname/code validation   \
```

### Unit tests (the bulk — cheap, deterministic)

Everything that is a pure function or an in-memory state machine:

- **FSM transitions** — the single highest-value unit target. For every `(state, event) → state'` pair:
  - valid transitions succeed and emit the right side-effect intents;
  - **every invalid transition is rejected explicitly** (e.g. `SUBMIT` during REVEAL, `NEXT_ROUND` from a non-host event source, `JOIN` after LOBBY_CLOSED). Enumerate them as table-driven tests: `cases.forEach(([state, event, allowed]) => ...)`. A table you can eyeball against the design doc beats 100 hand-written tests.
  - transition guards: host-only events, quorum conditions (all submissions in?), round counter bounds.
  - **illegal-transition invariant**: property test that from any reachable state, applying any event outside the legal set leaves state unchanged and returns an error — never throws.
- **Judge prompt construction & response parsing**:
  - prompt builder includes all submissions exactly once, in a stable order, with nicknames anonymized if that's the spec;
  - parser handles: valid JSON; JSON wrapped in ``` fences; leading prose before JSON ("Sure! Here's..."); truncated output; refusal text; scores out of range; ranks not a permutation of 1..N; duplicate ranks; missing players.
- **Scoring/ranking math**: tie-breaking, permutation validation, cumulative score accumulation across rounds.
- **Nickname validation**: length, unicode/emoji, homoglyph normalization, reserved words ("host", "judge", empty-after-trim).
- **Room code generation**: alphabet size, collision behavior, exclusion of ambiguous chars.
- **Message schema validation** (zod/io-ts/etc.): every inbound WS message type validates; malformed payloads are rejected at the boundary.

### Integration tests (the real meat — server + DB + fakes at the edges)

Spin up the **real server process** with a real DB via **Testcontainers** (Postgres container; Redis too if used), real websocket client connections, but:

- **LLM = fake judge**: a stub HTTP endpoint returning canned/parameterized responses (including malformed ones). Never call OpenAI in CI — slow, flaky, costs money, nondeterministic.
- **Spotify = fake**: stub the token refresh + playback API behind an interface. Assert on the commands your server *sends*, not Spotify's behavior.

Pattern: helper `createRoom(t) → {roomCode, hostClient}`, `joinPlayer(roomCode, name?) → playerClient` where each client is a thin WS wrapper with `await nextEvent(type)` promises. Then each test reads like the game:

```ts
const { code } = await createRoom();
const p1 = await joinPlayer(code, "Ana");
const p2 = await joinPlayer(code, "Bo");
await host.startRound();
await p1.submit({ title: "Song A" });
await host.nextState(); // or auto when all submitted
await expect(host.nextEvent("REVEAL")).resolves.toMatchObject({ rankings: [...] });
```

Cover these flows end-to-end:

1. Happy path: create → N joins → rounds × (submit → judge → reveal) → results.
2. Host drives all transitions; every host command rejected from a player connection (this is also security — see security doc).
3. Reconnect flow: drop a socket mid-round, reconnect with session token, assert state replay matches.
4. Room lifecycle: expiry timer fires, cleanup removes room + sockets get `ROOM_CLOSED`.
5. Persistence: kill server between submit and reveal (SIGKILL the process, restart against same DB container) — room resumes. This is your crash-safety guarantee and it's only testable with a real DB.
6. Concurrency: fire N submissions simultaneously (see §2).

Run against ephemeral ports; one container per test file, not per test (speed); truncate tables between tests.

### E2E (thin — Playwright multi-context)

**Is simulating host + N players feasible? Yes, comfortably.** Playwright's `browser.newContext()` gives isolated cookie/storage contexts in one browser instance; a room needs no accounts, so each context just opens the URL, enters a nickname, and it's a distinct player. 8 lightweight Chromium contexts in one headless browser is fine locally and in CI (~1–2 GB RAM). Tips:

- Use `page.waitForResponse`/WS-frame inspection (`page.on('websocket')`) to await game events instead of sleep-based waits;
- One shared `roomCode` fixture created by the host context;
- Don't assert on visuals beyond sanity — the deep assertions live in integration tests.

Keep e2e to **two flows** (more than that and they'll rot):

1. **Smoke**: host creates room → 4 players join → 1 full round → reveal shows ranked list → results screen renders. This catches "the app is fundamentally broken" in <2 min.
2. **Chaos-lite**: same, then the host hard-refreshes mid-round and the game continues (see §2c).

Do NOT try to e2e-test races, disconnect storms, or expiry timing — those are integration tests with direct socket control. Playwright is for "does the whole thing work through a real browser".

---

## 2. The Hard Multiplayer Cases

These are the tests worth writing carefully. Each maps to a concrete test recipe.

### a. Simultaneous submissions race
- **Recipe** (integration): start round with 8 players; `Promise.all(players.map(p => p.submit(...)))`; also variant where two submissions arrive in the same tick via raw frames.
- **Assert**: every submission recorded exactly once; "all submitted" triggers exactly ONE transition (idempotent trigger — double-fire must not advance two states or call the judge twice); final ranking covers all 8 entries; no submission lost or duplicated.
- **Also**: last-submission-wins vs first-wins policy for resubmission — pick one, test it explicitly.
- **Watch for**: check-then-act races on the submitted-count (use atomic DB ops or single-threaded per-room actor processing).

### b. Disconnect/reconnect mid-reveal
- **Recipe**: run to REVEAL; kill player 3's socket right before reveal broadcast; wait; reconnect with the session token issued at join.
- **Assert**: reconnecting player receives current state + the reveal payload (state snapshot/replay, not just future events); non-reconnecting players are unaffected; scoreboard reflects their score; disconnecting again mid-replay doesn't corrupt anything.
- **Edge**: reconnect with a *different* nickname → rejected or mapped by token, never creating a new player row; token expired → clean rejoin-as-new-player path (their old score is orphaned by design — document it).
- Timing note: use virtual/fake timers or injectable intervals in tests so you don't sleep real seconds.

### c. Host refreshes page mid-round
This is the #1 real-party killer. The host is a player with extra powers, so a refresh must be survivable.
- **Recipe**: e2e (it exercises real page reload) AND integration. Refresh host tab during SONG_SELECTION; also close-and-reopen within grace period.
- **Assert**: host re-authenticates silently (host token in sessionStorage/localStorage); room does NOT advance, pause, or die while host is gone; players see "host reconnecting…" after a threshold; host regains controls with correct state.
- **Decision to encode in tests**: what happens if host is gone > N sec? (pause round? auto-pause? promote co-host? For MVP: pause timer + allow reclaim via token; if token lost, allow reclaim from same nickname after confirmation — test whichever you choose.)
- Also test: host closes tab entirely during JUDGING (LLM call in flight) — judge result still lands, room waits.

### d. Duplicate nickname
- **Recipe**: second player joins with existing nickname while original connected.
- **Assert**: rejected with clear error (recommended MVP policy: reject live duplicates; allow reuse after the original left/disconnected). Variant: original disconnected → reuse succeeds and old session token is invalidated (old socket's messages now rejected).
- **Security angle**: this doubles as the anti-impersonation test — see security doc §player-impersonation.

### e. Late join during SONG_SELECTION
- **Recipe**: start round with 3 players; fourth joins mid-selection (and variants: mid-JUDGING, mid-REVEAL).
- **Pick a policy and pin it with tests**: recommended MVP — joining mid-round is allowed into LOBBY-like spectator state, they play from NEXT round; or reject with "round in progress". Either is fine; ambiguity is not.
- **Assert**: late joiner never appears in current round's judge input (prompt builder unit test covers this too); they receive full current-state snapshot on join; scoreboard includes them with 0 points; next round includes them.
- **Watch for**: judge prompt built concurrently with join — ensure submissions snapshot happens at transition time, not at judge-call time.

### f. Room expiry while players connected
- **Recipe**: integration with injected clock: create room, fast-forward TTL, with 4 live sockets attached.
- **Assert**: all sockets receive `ROOM_CLOSED` (reason: expired); server cleans up room state, timers, and subscriptions (assert via DB empty / internal registry empty — no leak); subsequent messages on dead sockets get clean errors, not crashes; a NEW room with the same recycled code can be created and works.
- **Edge**: expiry racing an in-flight judge call — judge result arrives after expiry, must be dropped without error noise.
- **Edge**: idle-vs-active semantics: activity resets TTL? Test both interpretations once chosen.

### Cross-cutting chaos idea (optional, high value)
An in-memory "flake harness": wrap the WS layer to randomly delay/drop/reorder messages, run the happy-path integration suite under it with a seed. Catches ordering assumptions deterministically (reproduce failures by seed). Half a day to build, repays itself repeatedly.

---

## 3. Load Testing Plan

Target: **500 concurrent rooms × 8 players = 4,000 concurrent WS clients**, plus a judge call per round. Realistic party-game traffic is bursty (everyone submits within ~10s), so model bursts, not steady rate.

**Tool choice: k6** (first-class WS support, scripted scenarios, good CI story). Artillery works too but k6's `ws` API makes per-room orchestration easier.

### Scenario design

```
setup():   allocate judge-fake endpoint, note base URL
scenario:  executor 'shared-groups'? No — use constant-arrival-rate of ROOM CREATIONS
           arrival rate ramps: 0 → 25 rooms/sec over 60s, hold until 500 rooms live
each VU thread manages one room:
  1. POST /rooms            → roomCode
  2. spawn 8 ws connections (k6 ws module), join with unique nicknames
  3. loop R rounds (R=3):
       host sends START_ROUND
       each player sends SUBMIT within random 0–10s window (burst!)
       host requests judge → hits judge-fake (add ~1.5s latency, occasional 429s)
       verify REVEAL received on all 8 sockets, contains 8 ranked entries
       host advances
  4. teardown room
```

### What to measure (thresholds as k6 `options.thresholds`)
- `ws_connecting` / time-to-join p95 < 1s;
- **event delivery latency**: stamp `START_ROUND` send time, measure receipt on player sockets; p95 < 300ms, p99 < 1s at steady state;
- **fan-out correctness**: custom counter `reveal_mismatches` (wrong entry count / missing players) must be 0;
- HTTP API p95 < 200ms; error rate < 0.5%;
- judge-fake: queue depth and p95 turnaround < 3s (your LLM path will be the bottleneck — the fake tells you how the rest of the system behaves around a slow dependency);
- dropped WS connections counter = 0 (excluding deliberate churn scenario below).

### Variants beyond the base shape
1. **Churn**: 20% of players reconnect every round (tests reconnect storm cost).
2. **Slow judge**: fake latency 15s — does the room state machine handle it, do timeouts fire correctly?
3. **Zombie rooms**: create 500 rooms, let 400 go idle past TTL — measure memory + verify expiry sweep keeps up.
4. **Burst spike**: 100 simultaneous room creations (viral moment simulation).

### Practical notes
- Load-gen box sizing: ~4k WS clients ≈ fine on one decent machine, but run k6 separately from the server and watch both CPU graphs; if the generator saturates first, shard across two runs.
- Profile during the run (`--inspect`, flamegraphs, DB `pg_stat_activity`) — the point isn't pass/fail, it's finding the first bottleneck (usually: per-message DB writes, broadcast fan-out, or judge queue).
- Don't chase 500×8 in CI. CI runs a mini-version (10 rooms × 8) as a canary; full load runs nightly/manually pre-release.
- One honest caveat: 500 rooms × 8 players is far above a realistic playtest (a handful of rooms). Treat it as headroom insurance, not a launch blocker — a working 50-room target already de-risks the MVP.

---

## 4. AI Judge Output Validation — Property Tests

The judge is a non-deterministic external dependency whose output directly drives game state. Contract: given N submissions, parsed judgement has — for each player — an integer score in range, and a total ordering that is a **valid permutation** (no dupes/gaps), plus a string explanation per entry.

### Schema-first
Define the judgement schema once (zod/dataclass). Parser = strip fences/prose → parse JSON → validate schema → validate *semantic* invariants. Property tests target the semantic layer.

### Properties (fast-check / Hypothesis / etc.)

For arbitrary N ∈ [2..16] and arbitrary generated judgements mutated from a valid seed:

1. **Permutation property**: ranks form exactly {1..N} — no duplicates, no gaps. Generator: start from valid permutation, apply mutations (swap, duplicate a rank, delete an entry, shift by one, off-by-one rank N+1) — parser must accept the valid ones and *reject-or-repair* the mutants per your chosen policy.
2. **Range property**: every score ∈ [minScore, maxScore]; floats rejected (or rounded, per policy).
3. **Coverage property**: every submitted player id appears exactly once — no phantom players, no omissions. Feed submissions with adversarial ids (nicknames containing quotes, unicode, "null", very long strings) and confirm id matching survives serialization round-trips.
4. **Round-trip stability**: `parse(format(judge(parsed))) === parsed` (canonicalization holds).
5. **Monotonicity**: rank order agrees with score order (if you display both — decide whether rank is derived from score sort or independent; if derived, property-test that derivation instead of storing both).
6. **Parser robustness fuzz**: generate hostile strings (fenced JSON with prose, nested fences, truncated mid-token, JSON arrays instead of objects, numbers as strings `"3"`, null fields, extra unknown fields) — assert no throw escapes; outcome ∈ {valid parse, structured rejection}.
7. **Rejection ⇒ fallback**: whenever the parser rejects, the game takes a defined fallback path (retry once with stricter prompt → fallback judging, e.g. random-but-valid ranking marked "judge unavailable") — integration-test the fallback path so a bad LLM day degrades gracefully rather than stalling rooms. **Every fallback ranking must itself satisfy properties 1–3** — run the same property suite over the fallback generator.

### Determinism trick for integration tests
Property suites run against the *parser*, not the network. In integration, the fake judge emits parameterized outputs (valid, mutant #7, garbage) selected per test — so you test "system reacts correctly to malformed judgement #7" deterministically, forever.

---

## CI Shape (summary)

| Layer | Where | Budget |
|---|---|---|
| Unit + property | every push | <60s |
| Integration (Testcontainers) | every PR | <5 min |
| E2E (Playwright, 2 flows) | every PR | <5 min |
| Mini-load canary (10 rooms) | nightly | ~3 min |
| Full load (500×8) | manual/nightly | ~15 min |

**Definition of "ready for the party"**: all integration hard-cases (§2) green under the flake harness, e2e smoke green, one successful full-load run, judge-fallback path demonstrated.
