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

### D-E 🔄 Manual playback mode is first-class (superseded by D-020)
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

### D-014 🔄 Spotify spike stop-and-report gate (superseded by D-020)
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

### D-018 ✅ Phase 3–4 completion: durable orchestration + fallback-safe judge
- **Date:** 2026-08-25
- **Decision:** The checkpoint document now owns roster/token hashes, exact phase deadlines, submissions, playback/reveal cursor, results, and cumulative leaderboard. The host is a controller, not a song-submission quorum member. Judging is one provider-neutral batched call with strict coverage/permutation validation, bounded retries and deterministic hash fallback; OpenRouter is selected only by environment configuration.
- **Reason:** End-to-end audit found that the previous Phase 3 implementation could not authenticate browser search, could not complete manual playback, lost roster/submissions on restart, and used a timer-only placeholder judge.
- **Alternatives:** Keep post-round state ephemeral (rejected: restart mid-reveal would corrupt the party); require an LLM key (rejected: external outages may never stall a room).
- **Consequences:** Manual and API modes reach RESULTS; worst-to-best reveals update a persisted leaderboard; missing Spotify/LLM credentials degrade cleanly. Full-game and SIGKILL-style restart integration tests pin the behavior.

### D-019 🔄 Spotify authorization and playback are room-scoped (superseded by D-020)
- **Date:** 2026-08-25
- **Decision:** Only an authenticated room host may start Spotify OAuth. PKCE state binds the callback to that room, and search/playback resolve a provider through the room's encrypted token key. Ciphertext persists beside SQLite (or at `AUX_SPOTIFY_TOKEN_FILE`) and is purged when the room expires.
- **Reason:** A process-global “latest session” could let activity in one concurrent room select another host's account or device, and an in-memory grant forced every host to reconnect after a routine restart.
- **Alternatives:** One process-wide Spotify account (rejected: breaks room isolation); plaintext tokens in SQLite (rejected: violates the encryption boundary).
- **Consequences:** Concurrent-room tests pin distinct queues/devices, OAuth tests pin host authorization/state replay, and restart tests verify that the persistence file contains ciphertext only. Manual playback remains available when a room has no live grant.

### D-018 ✅ Phase 3 integration: submissions wiring + graceful search degradation
- **Date:** 2026-08-25 (reviewer FAIL → resolved)
- **Decision:** roundsRoute bound at composition root via an exposeRuntime seam (live phase + ALL_SUBMITTED dispatch through the FSM mutex); chicken-fill runs before the LOCKED advance on SONG_SELECTION timer expiry; search proxy degrades to the FakeProvider catalog on TOKEN_EXPIRED so song-picking works before host OAuth. Uniqueness enforced structurally in SubmissionStore (byPlayer/byMsg maps + JSON checkpoints) rather than DB constraints — DB-as-arbiter deferred to stage-1 per D-B.
- **Reason:** Reviewer correctly blocked Phase 3 completion on the ~30-line wiring gap; degradation path prevents a party dead-end.
- **Alternatives:** DB unique constraints now (rejected: stage-1 Postgres swap inherits them free); hard-fail search without OAuth (rejected: breaks pre-OAuth playtesting).
- **Consequences:** Kick close-code split (4403 kicked vs 4001 superseded) accepted as better than spec; AUX-006 CLOSED (FSM-backed snapshots).

### D-019 ✅ Judge consolidation + verdict broadcast shape
- **Date:** 2026-08-26
- **Decision:** Two parallel judge implementations were consolidated in favor of `judge/service.ts` (prompt/schema/service split); `judgement` WS frame carries `{payload:{results:[{rank,score,title,artist,explanation,nickname}]}}` best-first with roster nicknames joined at broadcast; results ride the orchestrator checkpoint slot rather than a new Checkpoint column; OpenRouter key absent ⇒ fully fallback-judged game.
- **Reason:** Parallel work produced overlapping judge files; service.ts matched the LLMProvider seam cleanly and the orchestrator wiring landed against it. Broadcast shape serves the reveal UI directly.
- **Alternatives:** Keep judge-service.ts (rejected: duplicate responsibility; folded/removed); new checkpoint field for judgements (rejected: optional orchestrator payload slot suffices).
- **Consequences:** No OPENROUTER_API_KEY = deterministic hash-judged game (still fully playable); reveal data ships post-judging only — anonymity preserved until RESULTS.

### D-020 🔄 Project-owned originals replace third-party streaming (superseded by D-021)
- **Date:** 2026-09-01
- **Decision:** Remove streaming-service OAuth, search, tokens, device control, and playback. The default approved catalog is AUX Originals: project-owned instrumental recipes synthesized locally with Web Audio and no samples. `playback_mode` is now `catalog|manual|silent`. Optional commissioned or purchased recordings enter only through the fail-closed licensed manifest described in `licensed-music.md`.
- **Reason:** A consumer streaming subscription does not grant the publisher the master/composition rights needed to embed music in an App Store game. Project-owned compositions remove that dependency and make playback work without an account or external device.
- **Alternatives:** Continue remote-control playback (rejected: service dependency and unsuitable product-rights boundary); ship third-party files without evidence (rejected); silent-only game (rejected: music is core to play).
- **Consequences:** The server canonicalizes every submitted id through the approved catalog; clients cannot inject metadata or URLs. The judge receives the canonical sonic profile. Release owners must keep authorship records for originals and full rights evidence for every optional licensed track. This design reduces licensing risk but is not a substitute for publisher legal review.

### D-021 🔄 Apple MusicKit supplies the selectable catalog (superseded by D-022)
- **Date:** 2026-09-01
- **Decision:** AUX Originals are disabled by default. Player search uses the official Apple Music catalog API and host playback uses MusicKit with host authorization and standard play, pause, and next controls. Apple streams DRM-protected audio directly; AUX BATTLES does not proxy or persist it. Publisher-controlled files with explicit game rights remain an optional second catalog.
- **Reason:** The product requires familiar, broadly available songs. Apple explicitly documents MusicKit use in apps and games, subject to user-initiated playback, subscription, controls, and its current terms. Spotify's current Developer Policy explicitly prohibits games. OpenFM exposes curated continuous radio rather than a documented on-demand catalog/developer platform, so undocumented stream endpoints are not an acceptable integration.
- **Alternatives:** Spotify (rejected by current game prohibition); OpenFM stream URLs (rejected: no official on-demand developer API or third-party game grant found); Apple/iTunes previews (rejected: previews cannot supply a game's entertainment value); restore AUX Originals as the default (rejected by product direction).
- **Consequences:** Deployment requires an Apple Music developer token and storefront. The host needs an Apple Music subscription for full playback and must initiate it. Song availability varies by storefront. The Next control is never provider-gated, so authorization or playback failure cannot deadlock a round. MusicKit does not replace synchronization/adaptation rights for any future timed, edited, recorded, or shareable use of a recording.

### D-022 ✅ Zero-setup song entry is the default; MusicKit is optional (see D-023 for the free search catalog)
- **Date:** 2026-09-01
- **Decision:** Players may submit any bounded title and artist without a catalog account. The server discards client-supplied URLs and artwork, trims the text, and creates a stable server-owned manual identity. During playback, the host receives user-initiated links to find that song in an external music service and controls Next directly. Apple MusicKit and publisher-controlled licensed files remain optional enhancements.
- **Reason:** Joining and running a room should not require developer credentials, streaming OAuth, or a particular subscription. A metadata-and-handoff flow makes the complete commercial repertoire selectable without AUX BATTLES copying, streaming, or automating third-party audio.
- **Alternatives:** Make MusicKit mandatory (rejected: deployment and host-account setup); use undocumented OpenFM streams (rejected: no official on-demand integration); bundle recordings (rejected without song-by-song rights evidence).
- **Consequences:** The base game works with an empty music catalog and no music environment variables. The host manually starts playback in a service they are permitted to use; AUX BATTLES does not promise synchronized or embedded audio in this mode. Search is available only when an optional catalog is configured, and Next is never provider-gated.

### D-023 ✅ Deezer previews supply free song search and host playback; production opt-in
- **Date:** 2026-09-05
- **Decision:** Add a Deezer catalog provider that uses Deezer's public, key-free API for song search and plays the 30-second preview clip Deezer publishes for each track. Search results and stored submissions carry metadata only; the host resolves a fresh, short-lived clip URL through a host-authenticated, room-bound endpoint and plays it in the browser `<audio>` element. The provider is on automatically in local development, off under `NODE_ENV=production` and `test`, and enabled in production only with `AUX_DEEZER_PREVIEWS=1`. Manual entry, MusicKit, and the licensed manifest are unchanged and can run alongside it.
- **Reason:** The product needs real, recognisable songs without a streaming account, developer token, or per-host subscription. Deezer is the only mainstream catalog whose search and preview endpoints work without credentials, which is why Heardle-style web games use it. Preview URLs expire after ~15 minutes, so resolving them at play time (not at submission) is required for correctness and also keeps clip URLs away from players.
- **Alternatives:** iTunes Search API previews (rejected: Apple prohibits using previews as a game's entertainment value, D-021); YouTube IFrame player (deferred: legally the cleanest free path for commercial use, but Data API search quota is ~100 lookups/day per key and the official player must stay visible on the host screen); SoundCloud (rejected: API registration gated); Jamendo/Audius/Free Music Archive (rejected: no mainstream catalog); Deezer enabled unconditionally (rejected: Deezer's developer terms §IV are non-commercial, so a paid build must consciously opt in).
- **Consequences:** `Track.source` gains `deezer`; `Track.playableMs` records that the host plays a 30-second clip so the excerpt window starts at 0 while cards still show the real song length. `ApprovedMusicCatalog.playableTrack` now receives the canonical stored track instead of an id, which lets remote catalogs (Apple Music, Deezer) survive a server restart without in-memory caches and removes the Apple-specific fallback from the orchestrator. `CombinedMusicCatalog.search` tolerates a failing provider instead of failing the whole search. The release owner must obtain a Deezer agreement or leave the flag off in commercial builds; see `deezer-music.md`.

### D-024 ✅ YouTube is the commercially usable free catalog and player
- **Date:** 2026-09-05
- **Decision:** Add a YouTube catalog provider: player search through the YouTube Data API v3 (server-side key) and host playback through the official IFrame embedded player, visible inside the playback card. Track ids are `youtube:<videoId>`, so playback needs no further quota. Search results are cached for six hours and identical concurrent queries share one request. The provider is enabled by `AUX_YOUTUBE_API_KEY`; when present, the Deezer dev catalog defaults to off.
- **Reason:** Research (docs/youtube-music.md, D-023) found that every free music-service API either bans games (Spotify, SoundCloud) or bans commercial use (Deezer, TIDAL), and Apple restricts iTunes previews to store promotion. YouTube's terms allow commercial apps with a visible official player and branding, and its search has the popularity ranking a party game needs. MusicBrainz was evaluated as a free metadata search to conserve quota and rejected: no popularity signal (covers outrank originals) and search latency up to tens of seconds.
- **Alternatives:** YouTube search via the IFrame `listType=search` (removed by YouTube in 2020); MusicBrainz metadata + YouTube playback (rejected, above); iTunes Search API metadata + YouTube playback (rejected: Apple's promotional-use terms); stay Deezer-only (rejected: non-commercial terms).
- **Consequences:** `Track.source` gains `youtube`. The default Data API quota (~99 searches/day) suits development only; the release owner must pass YouTube's free compliance audit for a quota extension before launch. The host screen shows video, so a YouTube round is visual by design; audio-only or background playback is not offered, per policy III.I.7-9. A paywall must never gate the embedded video, and ads must not sit on the playback screen.

### D-025 ✅ Judge rubric scores scenario fit, mood, lyrics, genre, wildcard; DJ AUX speaks the verdict
- **Date:** 2026-09-05
- **Decision:** The per-track rubric becomes scenarioFit 0-3, mood 0-2, lyrics 0-2, genre 0-2, wildcard 0-1 (total 10). The judge returns a verdict headline, a 3-4 sentence explanation that must name the mood read, what the song is about, and the genre call against concrete beats of the scenario with at least one genuinely funny observation, and a spoken `quip` (max 140 chars). The host mascot types the verdict and quip out with an animated mouth during AI_JUDGING and RESULTS; the judging card shows the rubric and the quip. The deterministic offline judge produces the same shape with tiered quips.
- **Reason:** Players asked for judging that reflects mood, lyrics, and genre rather than a generic "thematic fit", and for comments that read as real and funny instead of robotic. Giving the mascot the line makes the judgement feel delivered rather than printed.
- **Alternatives:** Keep the old five categories and only reword the prompt (rejected: the UI could not show lyrics/genre reasoning); a separate lyrics lookup service (rejected: licensing and latency; the model reasons from widely known themes and is told never to quote lyrics).
- **Consequences:** `JudgingCategories` keys change; in-flight rooms judged before this deploy will fail snapshot validation on the host, which is acceptable for hours-lived rooms. Tiebreaks now prefer scenario fit, then wildcard + mood, then lyrics + genre. Anonymity, anti-popularity and anti-title-matching instructions are unchanged.

### D-026 ✅ Players defend their pick; the judge argues with them
- **Date:** 2026-09-05
- **Decision:** The song-selection screen gains an optional 160-character "defend your pick" field submitted with the track. The server strips control characters, collapses whitespace, and caps the text; it is stored on the submission, shown anonymously on the host judging card and reveal card, and passed to the judge as untrusted data labelled as the player's closing argument. The prompt must address the defense directly (reward a real connection, tease a bluff, never let it override what the song is; it may move only the wildcard score) and must tie every sentence to a concrete scenario detail and a concrete song fact. Deezer is now an explicit opt-in only; YouTube is the product catalog. The mascot's dashed ring and the typewriter speech are removed; talking is a five-second mouth animation on each verdict and each reveal, and the phase rail at the top of the host screen is gone.
- **Reason:** Owner feedback after playtests: judgements felt generic, players wanted to argue their case, the mascot should look like it talks rather than print text, the dashed ring and the top progress rail were visual noise, and the dev default of Deezer contradicted the YouTube decision.
- **Alternatives:** Mandatory defense (rejected: slows the lock-in on phones); defense affecting all rubric categories (rejected: a good argument should not outweigh a song that does not fit).
- **Consequences:** `SubmissionRequestSchema.defense`, `Snapshot.judgingDefense`, and `results[].defense` are added. Prompt-injection posture is unchanged: the defense is JSON-quoted and declared untrusted. Local development needs `AUX_YOUTUBE_API_KEY` in `.env` for any search catalog.

### D-027 ✅ Song gallery search + best-video resolution; judge everything up front; host autoplay
- **Date:** 2026-09-05
- **Decision:** Player search is served by a metadata-only song index (iTunes Search API: titles, artists, albums, cover art, durations, store links; no previews are fetched or played). Picks are `song:<id>` tracks; on submission the server looks the song up and resolves the best embeddable YouTube video (official/VEVO/Topic channel, title and artist match, duration within tolerance, alternate versions penalised) with one `search.list` + one `videos.list`, so YouTube quota is spent per submitted song, not per keystroke. Without a YouTube key the same gallery still works and picks become canonical manual tracks. Judging now starts every track's judgement concurrently when AI_JUDGING begins (two attempts of ten seconds each), so each host reveal is instant. Host playback cards autoplay YouTube, Deezer, licensed, and original tracks when they come up; a blocked autoplay shows a Play button instead of an error.
- **Reason:** Owner feedback: judging felt slow or stuck (sequential on-demand LLM calls with up to 45 s of retries per track), search should be a song gallery rather than raw video titles, the game should find the right video itself, and the host should not have to press Play on every card.
- **Alternatives:** YouTube-only search (kept behind `AUX_SONG_SEARCH=0`; costs 100 units per keystroke burst); MusicBrainz metadata (rejected in D-024); Deezer metadata (non-commercial terms).
- **Consequences:** Apple's Search API terms frame the data as store promotion, so each gallery result links to its store page and nothing from Apple is played; confirm this framing with counsel alongside D-023. Set `AUX_YOUTUBE_API_KEY` for in-game video; without it the game is search-plus-manual. The `song:` id prefix is resolved server-side and never stored; queue tracks always carry `youtube:<videoId>`.

### D-028 ✅ Embedded playback falls back through ranked candidates
- **Date:** 2026-09-05
- **Decision:** A resolved YouTube track carries `videoCandidates`, an ordered list of up to six same-song uploads that pass every API check (embeddable, public, not live, not region-restricted for `AUX_YOUTUBE_REGION`). Candidates are ranked by official channel (VEVO or the artist's own), exact title match, "official video/audio" in the title, and runtime, with Topic auto-generated art tracks, covers, karaoke, lyric uploads, parodies, and unrelated channels ranked down. The host player tries candidates in order and moves on whenever the iframe reports an error (removed, private, embedding disabled, region-blocked) or a ready player exposes no duration; if all fail it shows a one-line message and advances to the next song after six seconds. Playback autoplays when a card appears; the Play button shows only when the browser blocked the start or playback failed.
- **Reason:** Playback failed with "This video is unavailable" although lookup succeeded. Two causes: the `videoSyndicated=true` search filter excluded most label/VEVO uploads, leaving Topic art tracks and re-uploads that the API marks embeddable but the iframe refuses; and the API cannot prove iframe playability at all (oEmbed and the embed page give no signal server-side), so the browser must be the final judge.
- **Consequences:** Each submission costs one or two `search.list` calls plus one `videos.list`. `Track.videoCandidates` is added to the shared schema. The iframe fallback is only exercisable in a real browser.

### D-029 ✅ The host picks a vibe; scenes are one short, felt image
- **Date:** 2026-09-05
- **Decision:** The round prompt catalogue moves to `@aux/shared` as eight vibes (Hype, Feel-Good, Sad Hours, Awkward, Pure Comedy, Movie Moment, Villain Era, Throwback), each with twelve one-sentence scenes of 4-14 words that name a single instantly recognisable moment ("Training montage for a one-year-old football prodigy.", "Wannabe rapper releases his very first song."). The host's CATEGORY step becomes a vibe picker with a Surprise option and a free-text prompt; a vibe id draws a non-recent scene from that vibe, surprise draws from any vibe, and custom text is used verbatim as the prompt. The old "Pick: <category>." suffix is removed.
- **Reason:** Owner feedback: prompts often made no sense. The cause was structural: the host's category ("breakup anthems") and the scenario (drawn from a random unrelated theme) were independent and glued together, and the scenes themselves were multi-clause paragraphs. Players should read a prompt and feel something immediately.
- **Alternatives:** Keep categories and rewrite scenes only (rejected: the mismatch would remain); LLM-generated prompts (rejected: latency, cost, and inconsistent tone).
- **Consequences:** `Snapshot.category` now carries the vibe name ("Hype", "Custom"). Recent-scene history is per room and bounded at sixteen. Tests enforce the length and single-sentence rules so future additions stay on point.

### D-030 ✅ The host screen must be opened by hostname, never by IP
- **Date:** 2026-09-06
- **Decision:** The dev launcher opens the host screen at the machine's LAN hostname (macOS mDNS `Name.local`) when it serves the page, else `localhost`, and passes the LAN IP to Vite as the phones' join origin so the QR stays reachable. The host lobby and the Listening card detect an IP-address origin and show a fix-it link to the same page on `localhost`. Production and native builds already use hostnames (a real domain, `https://localhost` on Android).
- **Reason:** Verified in headless Chromium against the exact failing ids: from `http://localhost` and `http://Daniels-MacBook-Air.local` every video (VEVO, Topic, lyric channels, re-uploads) played; from `http://127.0.0.1` and `http://192.168.0.122` every video returned error 150. YouTube refuses embeds whose parent origin is a bare IP address, and the launcher had been printing the IP URL for the host.
- **Alternatives:** Proxying or extracting streams (rejected: violates YouTube's terms); tunnelling dev traffic to a public domain (works, but unnecessary once a hostname is used).
- **Consequences:** Hosting from a TV or second laptop on the LAN uses the `.local` name. The candidate fallback chain from D-028 remains for genuinely embed-disabled uploads.

### D-031 ✅ YouTube plays through a relay page on the game's own https origin
- **Date:** 2026-09-06
- **Decision:** The host page no longer embeds YouTube directly. It embeds `/yt-relay.html`, a static page served from the game's own origin (`VITE_AUX_PUBLIC_ORIGIN`, the deployed https domain, in native builds; the page's own origin on the web), and that page hosts the official IFrame player. Parent and relay talk over `postMessage` with a tagged protocol (state, time, error events down; play, pause, seek, stop commands up); the parent accepts messages only from its own relay frame and the relay accepts commands only from its parent. Candidate fallback, autoplay guard, and error classification are unchanged.
- **Reason:** YouTube rejects players whose parent origin is not a real http(s) hostname. Capacitor serves the iOS bundle from `capacitor://localhost`, which WKWebView cannot change to https, so an iPhone-hosted game could never embed directly. Verified in headless Chromium: parent pages on 127.0.0.1 and 192.168.0.122 (error 150 for every video when embedding directly) play every upload through a relay on `localhost`. YouTube only sees the relay's origin.
- **Alternatives:** Loading the whole iOS app from the remote domain via `server.url` (works, but makes the bundle a thin wrapper and requires connectivity to open at all); a native player plugin (works, more code, iOS-only).
- **Consequences:** Native builds require the deployed backend to serve the web dist (it already does) so `https://<domain>/yt-relay.html` exists; without a deployed domain the iOS app cannot play video. The relay page is plain HTML with no build step and must not set framing headers. The IP-address warning now checks the relay origin rather than the page origin.

### D-032 ✅ Judgements are four one-sentence bullets
- **Date:** 2026-09-06
- **Decision:** The judge returns `reasons` (exactly two concrete one-sentence reasons naming something recognizable about the song: theme or hook, mood, energy, reputation, title, artist, iconic moment, cultural association), `defense` (one sentence on whether the player's defense strengthens the pick), and `verdict` (one decisive sentence), each capped at 160 characters and 20 words. The server joins them into `explanation` for players and stored results. The host judging and reveal cards render the bullets with Defense and Verdict labels; the uppercase headline and the spoken quip are removed. The fallback judge produces the same shape.
- **Reason:** Owner feedback: paragraphs were slow to read on a party screen and drifted into generic praise. Bullets force one concrete observation per line and are readable at a glance.
- **Consequences:** The response schema requires `reasons`, `defense`, and `verdict`; a model that omits them fails validation and the round falls back deterministically. Old results without bullets still render as prose.

### D-033 ✅ The offline fallback judge is conservative and says what it cannot know
- **Date:** 2026-09-06
- **Decision:** Without a live model, the per-track fallback scores neutral (scenarioFit 1.5, mood 1, lyrics 1, genre 1, wildcard 0.5 = 5.0) and moves only on facts it holds: words the title or artist share with the scene (scenarioFit), words a catalog description shares with the scene (lyrics, genre), and a defense that is substantive or names the scene (wildcard). Its bullets state that lyrics, mood, and reputation are unverified and that an AI judge would be sharper. Hash-seeded scores and invented song facts are gone from this path.
- **Reason:** Owner feedback: a fallback that gave "I Will Survive" 4.5 for an explosion scene, with confident-sounding prose, was arbitrary and misleading. The offline judge cannot hear songs; pretending otherwise undermines trust in the live judge too.
- **Consequences:** Offline rounds mostly tie; ranking then falls to the orchestrator's deterministic tiebreaks, which is acceptable for playtests without a key. The legacy batched `judgeRound` fallback is unchanged. Live OpenRouter judging is unaffected and remains the source of specific, funny reasoning.

### D-034 ✅ Visual identity: "studio stage" design system
- **Date:** 2026-09-06
- **Decision:** One design system for both apps, defined in `shared-ui/tokens.css` and `shared-ui/shell.css`: a dark warm stage (ink 950/900/800), warm off-white type (cream), a single hot primary (AUX orange) for actions and stamps, acid lime reserved for scores and wins, and semantic good/warn/bad. Print motifs replace glows and gradients: 2px rules, rotated stamps, tabular numerals, solid offset shadows. Bricolage Grotesque (self-hosted, OFL) is the display face; the system font is the body face. Buttons are arcade-style with a solid bottom edge that presses down. Host screens are composed as a show: a show bar (mascot, round, phase, timer, tools) and one full-height screen per phase with a pinned primary action; the ticket-style room code and QR only appear in the lobby. Player screens have a top strip, one task, and a sticky CTA above the keyboard. The mascot is a character with a mood per game beat (welcome, search, listen, think, praise, roast, reveal, celebrate) and a mouth animation for verdicts; it lives in the show bar on phones and as a stage presence on the landing page.
- **Reason:** The previous look had accreted through many prototypes: purple/blue gradients, neon rings, glass panels, mixed radii, dead classes and two reveal implementations. The product is an installed iPhone party game; it needs a recognisable identity, room-distance readability on the host, and thumb-first clarity on phones.
- **Cleanup:** removed the unreachable `ResultsReveal`, the unused `Reveal` payload/publish path, the batched `judgeRound` prompt/schema/tests, the duplicate `openrouter-provider.ts`, the fake LLM provider, the crowd meter, the phase rail, the old host/player/track-card/reveal stylesheets and all dead selectors. Fixed on the way: the reveal finalised the round before the winner card could be seen; the host's picks count ignored live `submission_received` frames.
- **Consequences:** Every screen's markup changed; `docs/frontend-spec.md` describes the older layout and should be read as intent, not as the current DOM. Real-device checks still needed: safe areas on notched iPhones, the sticky CTA over the iOS keyboard, and mascot animations under reduced motion.

### D-035 ✅ Judge v3: the server enforces uncertainty; no fallback scorer
- **Date:** 2026-10-08
- **Decision:** Prompt `round-fit-v3`. The model self-reports `knowledge` (`known` / `artist_only` / `unknown`) before its reasons and scores. Code pins categories the model cannot know to neutral (lyrics unless `known`; mood, genre and lyrics for an unknown song without a catalog description) and reports `confidence` high/medium/low, shown to players when low. The model no longer returns a total; the server sums categories. Judge lines containing links or markup are rejected. Equal AI totals with equal scenario fit share a place instead of being split by track ID. The deterministic offline fallback (D-033) is removed: gameplay already required AI (`requireAi`), so it was unreachable; failures switch the whole round to crowd voting. A labeled benchmark (`judge/benchmark.ts`) drives an offline regression suite and an opt-in paid evaluation (`npm run judge:eval`).
- **Reason:** The prompt asked for neutral scores when the model did not recognize a song, but nothing enforced it, so a confident guess could still decide a round. Arithmetic, ties and uncertainty are rules, not judgement. An unreachable fallback is untested surface.
- **Consequences:** Supersedes D-033. Persisted `fallback-hash` results from older versions still render as "Offline scoring". The live benchmark has not yet been run against a funded key; run it before launch or any model change.

### D-036 ✅ Free, open AI judge for a non-commercial party site
- **Date:** 2026-10-08
- **Decision:** The project is a free portfolio/party website, not a commercial app. `AUX_AI_ACCESS=open` (the default) gives every host the AI judge with no sign-in or purchase: the start page offers "DJ AUX" or "The room" (crowd vote). Free games are reserved under a house account (`open-access`) in the same durable ledger, so every model attempt still passes the per-attempt reservation and daily/monthly budgets. A site-wide `AUX_OPEN_AI_DAILY_GAMES` cap bounds total use; past it, new games start with crowd voting instead of failing. A failed AI round in a free game falls back to crowd voting for that round only (nothing to refund). Player consent to sending picks to the AI provider is unchanged. The judge persona (prompt `round-fit-v4`) is tuned for adult pre-party groups: cheeky, light swearing allowed, roast the pick, never the person. The paid iOS mode stays available as `AUX_AI_ACCESS=account`.
- **Reason:** The owner wants the AI judge to be as easy to reach as possible for friends at a party and for portfolio visitors. Billing and Apple sign-in blocked every browser user from AI judging.
- **Consequences:** Anyone who finds the site can spend the operator's AI budget up to the caps; keep the caps low and set a provider-side credit limit on the OpenRouter key.

### D-037 ✅ Every scene has an agreed vibe that the judge scores against
- **Date:** 2026-10-09
- **Decision:** Catalogue entries are `{ scene, vibe }`. The vibe (3-10 words) names the one feeling the song must create. It rides the snapshot (`scenarioVibe`) and is shown on the host scenario poster, the host picks screen, the player's prompt and pick screens, the crowd ballot and the judging screen. The judge prompt (`round-fit-v5`) receives it as the BRIEF; scenario fit and mood are scored against it, and irony only scores when it still lands the brief. Custom prompts have no vibe; the judge picks the most obvious feeling. The benchmark gained same-scene/same-brief pairs where the brief-matching song must beat a situation-only match.
- **Reason:** Owner feedback: scenes like "the music stops while you slow-dance" were ambiguous (romantic or mortifying?), so players and the judge aimed at different targets and verdicts felt arbitrary.
- **Consequences:** New scenes need a vibe (the catalogue test enforces it). Persisted rooms from before this change have no vibe and are judged like custom prompts.

### D-038 ✅ Public launch defaults: small caps, an honest fallback, shareable links
- **Date:** 2026-10-09
- **Decision:** With open AI access and no budget env vars, the server defaults to 30 free AI games per UTC day, $0.50 per day and $3 per month (paid `account` mode keeps its larger defaults; explicit env values always win). When the free allowance is used up as a game starts, the room records `aiOffDuty`; the snapshot's `judgeNotice` (`off_duty` or `unavailable`) tells host and phones why the room is voting, and the lobby status says "DJ AUX is off duty for today". `host.html` gained a description, Open Graph and Twitter tags, a favicon and a 1200×630 share card (`/assets/og-card.png`); `player.html` is `noindex`; `robots.txt` keeps crawlers off `/api/`.
- **Reason:** The site is shared publicly from a portfolio, so anyone can spend the operator's AI budget, and a silent switch to voting looked like a bug. Bare links also gave no preview.
- **Consequences:** The og:image URL is relative until a domain exists; some link-preview crawlers need an absolute URL (owner checklist in DEPLOY.md).
