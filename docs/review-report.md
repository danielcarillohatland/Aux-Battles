# AUX BATTLES — Independent Design Review (Agent 6)

Reviewer: Independent Reviewer · Date: 2026-08-24 · Inputs: all 6 specialist docs read in full.

## 1. Per-document verdicts

| Document | Verdict | One-line rationale |
|---|---|---|
| architecture.md | SOUND-WITH-CHANGES | Right topology (single process, co-located state/sockets) and honest risk table, but four sections are superseded by rulings A/C/F/B below; "40^4" alphabet claim is internally inconsistent. |
| backend-spec.md | SOUND-WITH-CHANGES | Operationally the strongest doc: real schema, real concurrency code, real protocol. Needs storage-engine swap, manual-mode additions, and protocol-vocabulary reconciliation. |
| frontend-spec.md | SOUND-WITH-CHANGES | Reveal choreography is the best product thinking in the set. Its §3 protocol sketch and category-vote/READY features describe an app the backend doesn't specify. |
| aux-battles-spotify-deep-dive.md | SOUND | Best-researched doc; correct post-Feb-2026 Dev Mode framing, credible degradation ladder. Missing the L4 interaction contract (see E). |
| testing-strategy.md | SOUND | Correct pyramid inversion, right hard cases, honest load-target framing. Swap DB fixture per ruling B; add manual-mode coverage. |
| security-review.md | SOUND-WITH-CHANGES | Proportionate threat model; the 🔴 list is exactly right. Amend T4 threshold (ruling A) and add WS token-in-query-string mitigation. |

Dimension rulings: Architecture **SOUND-WITH-CHANGES** · Spotify abstraction seam **SOUND** · AI judging **SOUND** · Scalability honesty **SOUND** · UX & reveal **SOUND** · MVP scope **SOUND-WITH-CHANGES** · Unnecessary complexity **SOUND-WITH-CHANGES** (cuts in §5).

## 2. Findings and explicit RULINGS A–F

**A. Room codes — RULING: Backend wins. Canonical = 5 chars × 31-symbol alphabet (`ABCDEFGHJKMNPQRSTUVWXYZ23456789`, 31⁵ ≈ 28.6M), DB-unique-index rejection insert.**
Cited: Arch §4 (4-letter curated, "~2.56M") vs Backend §7 (5×31) vs Security T4 (≥6 chars, ≥24 symbols). 4 letters is genuinely weak under distributed guessing (arch's own collision math ignores multi-IP attackers); security's 6-char floor is directionally right but oversizes the fix — the wallet is protected by the 🔴 global LLM budget cap, not code entropy, and rooms live ≤6h. 5×31 plus the already-mandatory 🔴 per-IP join rate-limit + lockout puts single-room discovery into multi-day territory. Security doc amends T4 wording accordingly; arch doc deletes its 4-letter paragraph (and fixes the bogus "40^4" arithmetic).

**B. Persistence — RULING: Architecture wins for MVP. Authoritative in-memory state + SQLite (WAL) checkpoints behind the `RoomStore` interface; Postgres is the stage-1 swap, not shipped now.**
Cited: Arch §5 (memory + SQLite WAL, one-interface swap) vs Backend §3/§4 (Postgres/Drizzle, constraints as arbiter). A second always-on service (Postgres) on the party VPS violates the "simplest thing" mandate at <500 rooms; SQLite WAL handles the stated write volume trivially. BUT backend's integrity insight survives the swap: port the unique constraints into SQLite — `UNIQUE(round_id, player_id)` (one song), `UNIQUE(round_id, client_msg_id)` (idempotency), `UNIQUE(room_id, lower(nickname))` via `COLLATE NOCASE` — so the DB remains the race backstop (23505 → ALREADY_SUBMITTED/NAME_TAKEN unchanged). `RoomStore.get/put/delete` stays untouched so stage 1 is config, not surgery. Backend schema retargeted: citext→NOCASE, timestamptz→INTEGER epoch-ms, uuidv7→TEXT. Testing swaps Testcontainers-Postgres for tmpfile SQLite fixtures (faster CI, same crash-safety guarantee — SIGKILL-restart test unchanged).

**C. Timers — RULING: Backend wins. One `setTimeout` per room ONLY while a timed phase is armed; `phase_deadline` persisted; callback re-enters the FSM through the room mutex (`TIMER_EXPIRED`); boot-time sweep re-arms overdue deadlines and fires immediately. The global 1s ticker is deleted as a state-advancing mechanism; a ~60s interval sweeper remains for TTL/cleanup only.**
Cited: Arch §2 (single 1s ticker scanning `phase_deadline`) vs Backend §6 (deadline-persisted timeouts, +25ms guard, mutex-serialized expiry). Arch's "avoid thousands of live timers" fear is empirically wrong here — idle rooms hold zero timers, active rooms ≤1–2; even 500 rooms is noise for Node. Backend's design gives exact deadlines, whole-second tick derivation from the absolute deadline (drift-proof), and resolves expiry-vs-host-skip races serially through the mutex. The one thing the ticker did better — uniform crash catch-up — is preserved by the boot sweep. Both docs edited to name this single mechanism.

**D. Frontend ↔ Backend protocol — RULING: mismatch confirmed; backend's REST-for-mutations + read-mostly-WS is canonical; frontend §3 sketch is rewritten. Matches:** seq stamps ✓, epoch-ms deadlines ✓, full-snapshot resync ✓ (fresh handshake returns `state_change`), rejoin token ✓ (`/reclaim`). **Mismatches:** (1) frontend invents WS actions (`vote`, `lock`, `ready`, `host:{...}`) where backend mandates REST; (2) frontend's `resync{lastSeq}` frame doesn't exist — reconnect is a new WS handshake; (3) frontend expects one-shot deadline events and rejects tick streams; backend broadcasts 1s `timer_tick` (harmless but unpsecified — clients may ignore); (4) entire event vocabulary differs (`snapshot/phase/tally/sealedCount/revealStep/revealWinner/kicked` vs `state_change/timer_tick/submission_received/judgement/reveal_owner/game_over`); (5) frontend store phases (`vote`,`submit`) ≠ FSM states (`CATEGORY`,`SONG_SELECTION`); (6) heartbeat 10s vs 15s; (7) biggest functional gap: frontend builds a **player category-vote UI** (§2.5) and a READY toggle (§2.4) with no backend counterpart whatsoever — backend CATEGORY is host-pick-only. Cut both from MVP (see §5).

**E. Spotify degraded path — RULING: deep-dive verdict endorsed (previews dead in Dev Mode; L4 manual is first-class), but the degraded path is NOT yet deeply enough designed to build from. Three gaps:** (1) no `playback_mode: 'api'|'manual'|'silent'` field in snapshots — phones must know to say "watch the speaker"; (2) L4 track advance is unspecified: deep-dive implies server-duration scheduling, but manual playback drifts (song-finding latency, scrubbing) — manual mode must be **host-tap-driven** ("Song done → Next"), pausing the round clock between tracks; (3) frontend has no manual-mode screen (its playback wireframe is remote-control-centric: progress ring, volume, crossfades; winner screen auto-plays an 8s chorus that silently fails in L4). Fix: one host manual-card + one player banner + mode field + host `manual_next` action. `previewOnly` in `playback_cue` is dead code unless a day-one probe finds previews alive — demote it.

**F. Duplicate nicknames — RULING: Backend + Testing win. Reject live duplicates (`NAME_TAKEN`); a disconnected player's name becomes reclaimable via `/reclaim`, which issues a fresh token and invalidates the old session.** Cited: Backend §2.6/§5(b) and Testing §2d (reject-live, reclaim-after-disconnect, old-token invalidation — all aligned) vs Arch §6 and Frontend §2.3 (auto-append `#2`/`₂` suffix). Auto-suffix contradicts the reclaim flow (a suffixed name is no longer a stable reclaim handle), and both policies are equally safe once identity = session token (Security T9). Arch and frontend lines amended; frontend swaps the suffix-toast for an inline NAME_TAKEN error + suggestion. Testing doc's §2d already pins the winning side — keep its variant assertions.

## 3. Top risks (ranked)

1. **Spotify Dev Mode playback reliability** — the product IS the playback. Previews dead, transfer flaky, owner-Premium lapse bricks everything. Mitigation exists (ladder) but the orchestrator is the highest build-risk component: prototype preload-and-verify (deep-dive §4.1) in week 1.
2. **Protocol drift between frontend and backend** — built as written, the two halves don't connect (ruling D). Blocking condition: shared Zod types package as single source of truth.
3. **Host-side single points**: allowlist-before-party, Premium lapse, device sleep. Operational checklist items, cheap, easy to skip until they bite.
4. **LLM spend/injection** — bounded by global budget cap + strict schema + permutation validation; residual accepted (party game).
5. **Anonymity leak via ordering/timing** — server-side shuffle specified; needs an explicit test.
6. **Single-process restart blip mid-party** — write-ahead + lazy hydration + reconnect make it a ~5s blip; accept residual.

## 4. Concrete changes per owning document

- **architecture.md**: apply rulings A (replace code paragraph, fix arithmetic), B (note RoomStore enforces unique constraints), C (delete ticker-as-advance, keep TTL sweeper), F (delete auto-suffix bullet).
- **backend-spec.md**: retarget §4 to SQLite preserving all unique constraints; add `playback_mode` to snapshots + `manual_next` host action (E); demote `previewOnly`; document reconnect-as-handshake (drop invented `resync` frame); replace token-in-query-string with a short-lived one-time connect ticket; delete `host_skip_wait` WS mirror (one mutation path).
- **frontend-spec.md**: rewrite §3 protocol sketch in backend vocabulary (REST mutations, read-mostly WS, canonical frame names); cut VoteScreen + READY toggle from MVP; NAME_TAKEN inline error replaces suffix toast; add manual-mode host card + player banner; gate winner-screen chorus on `playback_mode==='api'`; heartbeat 15s.
- **spotify-deep-dive.md**: add L4 interaction contract (host-driven advance, clock pauses between tracks, mode broadcast); move file into `docs/`.
- **testing-strategy.md**: SQLite tmpfile fixtures replace Testcontainers-Postgres; add manual-mode round integration test (advance-by-host, paused clock, results intact); assert reconnect snapshot seq continuity; §2d pinned to ruling F.
- **security-review.md**: amend T4 to accept 31⁵ + enforced join rate-limit/lockout; add connect-ticket mitigation for token-in-URL logging; fix §-numbering starting at 5.

## 5. Complexity cut list (MVP)

Cut: player category-voting system (screens, tally frames, optimistic-vote reconciliation — host picks); READY toggle; `host_skip_wait` WS mirror; `judge_progress` streaming chunks; `previewOnly` cue path (keep only the optional `getPreviewClip` day-one probe); ack-keyed resend buffer (seq for gap detection, snapshot-on-resync for repair); emoji reactions ("if even that" → no); GSAP (default CSS+WAAPI; revisit only if the reveal timeline proves awkward).

## 6. GO ruling: **GO-WITH-CONDITIONS**

The design set is unusually coherent on what matters (single-process authority, provider seam, judge validation, degradation ladders) and honest about scaling. It is buildable now, provided:

1. **Rulings A–F above are applied to all six docs before implementation starts** — especially the single canonical protocol vocabulary (D) and duplicate-nickname policy (F).
2. **Shared Zod types package (`@aux/shared`) exists before any client code**; frontend §3 rewritten against it.
3. **Week-1 spike: Spotify preload-and-verify orchestrator behind `MusicProvider`** with FakeProvider; L0 and L4 must both be demo-able before reveal polish is built.
4. **Security 🔴 items ship inside the first vertical slice** (tokens, role checks, input caps, LLM global budget + provider spend cap, rate limits, Origin checks, secrets hygiene) — not as a follow-up.
5. **Judge path ships with strict schema + permutation validation + tested fallback** from day one (testing §4 properties green).
6. **Manual mode (L4) is in the MVP definition-of-done**: mode field, host-driven advance, integration tests — it is the product's insurance policy, not an apology screen.
