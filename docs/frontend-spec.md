# AUX BATTLES — Frontend Design Spec (MVP)

> Status: v1 · Scope: browser-only (no native apps) · Players = phones (mobile-first), Host = desktop/tablet on a big screen.
> Design north star: **the reveal is the product**. Everything else is scaffolding that gets us to it fast.

---

## 1. Framework Choice

### Recommendation: **Vite + SolidJS + TypeScript**

| Option | Verdict |
|---|---|
| **Vite + SolidJS** | ✅ **Chosen.** Fine-grained signals → zero VDOM diffing; a leaderboard row updates without touching the other nine. ~7 kB runtime vs ~45 kB react-dom. Cold JS payload target < 90 kB gz total including socket client. Instant HMR for iterating on reveal animations. |
| Vite + Svelte 5 | Strong runner-up. Runes ≈ signals, great DX, ~10–12 kB runtime. Choose instead if the team already writes Svelte. Everything in this spec is framework-agnostic except component syntax. |
| Vite + React | Acceptable fallback (largest ecosystem, most hireable). Requires discipline: memoized rows, `useSyncExternalStore` over the socket store, virtualization not needed at ≤ 32 players. Payload penalty ~3×. |
| Next.js / RSC | ❌ Rejected. This app has **no SEO surface** (rooms are ephemeral, behind `/r/:code`), no content pages, no SSR benefit — the first paint of value is *socket-connected state*, which SSR can't provide. Server components add an adapter layer between us and a raw WebSocket we must own anyway. Ship static from the same host that runs the WS server; one deploy artifact, CDN-cheap. |

### Why Solid specifically for *this* app
1. **The reveal is a timed choreography of many independent animated values** (rank counters, blur-ins, screen shake, audio cues). Signals let each animation tick its own value without re-rendering sibling DOM — critical when a phone from 2020 in a loud bar is our median device.
2. **Two apps, one repo**: host shell and player shell share types, store logic, and theme tokens but render different trees. Vite multi-entry (`host.html`, `player.html`) keeps each bundle small — players download only the player bundle.
3. Realtime means state lives in **stores outside the component tree**, updated by socket events; fine-grained consumers subscribe to slices, so a "player joined" event costs one `<li>` insertion.

### Supporting stack
- **Styling:** vanilla CSS with custom properties (design tokens) + CSS Modules per component. No Tailwind dependency-weight argument either way; pick per team taste. Animations: native CSS transitions/keyframes + Web Animations API for orchestration; **GSAP timeline** (small, ~23 kB core) allowed *only* inside the reveal scene where precise sequencing pays for itself.
- **Routing:** minimal — `@solidjs/router` or hand-rolled 4-route switch. Landing / Join / Player-game / Host. Hash-free, history API.
- **State:** one `RoomStore` (signals) fed by a single typed socket bus (see §3).
- **Audio:** WebAudio API for synthesized stingers/ticks (no asset loading latency, pitch/volume controllable per beat) + optional short MP3s for crowd/whoosh. All audio gated behind a user-gesture unlock (first tap).
- **Haptics:** `navigator.vibrate()` where supported — free polish on Android (reveal beats pulse the phone).

### Repo layout
```
/apps
  /shared        # types, protocol events, room store, socket client, tokens.css
  /host          # host.html entry — lobby, playback, reveal stage, leaderboard
  /player        # player.html entry — join, lobby, vote, submit, waiting, personal reveal view
/server          # (backend agent owns) — ws + REST, same protocol types
```

---

## 2. Screen Inventory & Wireframes

All screens share: dark stage background (#0E0B16 base), one accent gradient (hot magenta→electric violet), display font for headlines (e.g., "Archivo Black" or "Clash Display"), rounded-2xl cards, generous glow shadows. Motion language: spring easings (overshoot 1.2), nothing under 150 ms.

### 2.1 Landing (desktop-first, works on phone)
```
┌──────────────────────────────────────────────┐
│   AUX ⚔ BATTLES        [HOST A GAME]         │  ← big primary CTA, pulsing ring
│                                              │
│   "One category. One song. One winner."      │
│                                              │
│   or join:  [ room code input ] [GO]         │  ← 4-char code, auto-uppercase,
│                                              │    numeric keyboard? no — letters
│   footer: how it works · 3 tiny steps w/ icons│
└──────────────────────────────────────────────┘
```
- Animated background: slow-drifting vinyl/waveform blobs (CSS only, respects `prefers-reduced-motion`).
- Room-code input validates against server on complete code; wrong code shakes field inline.

### 2.2 Host Lobby (the "door")
```
┌──────────────────────────────────────────────┐
│  ROOM CODE                                   │
│      ┌─────────────────┐                     │
│      │   Q  R  CODE    │  ~55vh square       │  ← QR centered, white on dark card,
│      │   (huge)        │                     │    subtle breathing glow border
│      └─────────────────┘                     │
│   or type:  KZXW                             │  ← giant monospace letters, letter-
│                                              │    spaced, tap-to-copy
│  PLAYERS (n/16)                              │
│  ┌chip┐ ┌chip┐ ┌chip┐ ┌chip┐ …              │  ← nickname chips pop in with bounce;
│  ┌────────────────────────────┐              │    each new join plays soft "blip"
│  │ START ROUND 1        ▶     │  disabled    │    + confetti microburst on chip
│  └────────────────────────────┘  until ≥2    │
└──────────────────────────────────────────────┘
```
- Live player counter in tab title too (`(5) AUX BATTLES — KZXW`).
- Host can tap a chip to eject (with confirm popover). Settings drawer: rounds count, explicit-filter toggle, max song length.

### 2.3 Phone Join
Single purpose, thumb-sized:
```
┌────────────────┐
│  AUX BATTLES   │
│                │
│  YOUR NAME     │
│  ┌──────────┐  │  ← autofocused, maxlength 16, emoji allowed,
│  │          │  │    Enter = submit; live preview avatar chip
│  └──────────┘  │    above keyboard showing name + generated color
│  [ JOIN ▶ ]    │  ← sticky above keyboard so it's never covered
│                │
│  room KZXW ✓   │  ← persistent confirmation strip
└────────────────┘
```
- If QR was scanned, code prefilled & hidden; deep link `https://aux.battle/r/KZXW`.
- Duplicate-name handling: server appends "₂" style suffix, client shows notice toast.
- On success → haptic bump + slide-up into lobby.

### 2.4 Phone Lobby ("ready room")
```
┌────────────────┐
│  LOBBY · KZXW  │
│  6 players in  │  ← live list, your row pinned top with YOU tag
│  ● Maya  ● Sam │
│  ● You   ● Dev │
│                │
│   ┌────────┐   │
│   │ READY! │   │  ← big toggle; pulses while on
│   └────────┘   │
│  Waiting for   │  ← rotating funny status lines:
│  host to start │    "Sharpening the judge…" / "Warming up Spotify…"
└────────────────┘
```

### 2.5 Category Vote UI (phone)
```
┌────────────────┐
│ ROUND 2 of 5   │  progress dots
│ PICK THE VIBE  │
│                │
│ ╭────────────╮ │
│ │ 💔 Songs for│ │ ← tappable cards, 2-col grid, 4 options;
│ │ your enemy  │ │   selected = filled accent + scale 1.05
│ ╰────────────╯ │   (vote is optimistic — §3)
│ ╭────────────╮ │   live vote counts as thin progress
│ ╰────────────╯ │   bars under each card (adds FOMO energy)
│ ╭────────────╮ │
│ ╰────────────╯ │   timer ring shrinking around header dot
│ ╭────────────╮ │
│ ╰────────────╯ │
└────────────────┘
```
- If host has "host picks categories": skip straight to scenario splash with big typographic slam-in.

### 2.6 Song Search + Submission UI (phone) — *keyboard ergonomics are the whole job*
Layout is built **around the open keyboard**, not despite it:
```
┌────────────────┐
│ 🔎 [ search… ] │ ← input pinned TOP (never fights keyboard);
│                │   autofocus opens keyboard immediately
│ ── results ──  │ ← scroll area sized to remaining viewport
│ ▶ ♪ Blinding.. │   (dvh units); each row: art, title, artist,
│ ▶ ♪ ...        │   duration; tap row = select + preview snippet?
│                │   (MVP: no preview — keep taps decisive)
│ ── bottom ──   │
│ YOUR PICK:     │ ← sticky bar ABOVE keyboard (env(safe-area-
│ ♪ Song — Artist│    inset-bottom)); shows current selection
│ [LOCK IT IN]   │   always visible even while scrolling results
└────────────────┘
```
Rules:
- Search debounced 250 ms, min 2 chars; results capped at 10; skeleton shimmer rows.
- **Lock is a two-step**: tap LOCK IT IN → button morphs into "SURE? 🔒" for 1.5 s → second tap locks. Prevents fat-thumb tragedy, adds tension.
- After lock: keyboard dismissed programmatically, full-screen "SEALED 🤐" stamp animation over blurred pick. Cannot unseal.
- Empty query state shows category hint chips ("try: heartbreak, gym, 2000s") that inject text.
- Offline/no-results state offers "pick anyway later" → returns to locked-empty? No — MVP requires submission before lock; show retry + host-visible nudge.

### 2.7 Locked / Waiting states (phone)
Full-screen takeover, deliberately calm but alive:
- Giant padlock seal with your song title hidden behind frosted glass; slow float animation.
- Status line cycles: "Waiting for stragglers…" + live avatars of who's still unlocked (peer pressure = comedy).
- Subtle heartbeat pulse synced with a faint tick sound as timer nears zero.
- Timer expiry auto-locks whatever is selected; if nothing selected, AI Judge assigns you a random trending song and labels you "CHICKEN 🐔" at reveal (feature: shame-as-mechanics, cheap to build).

### 2.8 Host Playback Screen
```
┌──────────────────────────────────────────────────────────┐
│ ROUND 2 · CATEGORY: "Songs for your enemy"    ⏱ 03:12    │
│                                                          │
│ NOW PLAYING: ♪ ████████░░ 1:42/3:56                      │
│ "Song A" — Artist           [⏸] [⏭]  vol ▬▬▬▬▬           │
│                                                          │
│ QUEUE:  ✅ ① anonymous  ✅ ② anonymous  ⬜ ③ …            │ ← anonymized
│                                                          │   (colored by
│ [ PLAY ALL ▶▶ ]   [ SKIP REMAINING ]   [ FORCE REVEAL ]  │   later reveal)
└──────────────────────────────────────────────────────────┘
```
- Big touch targets; spacebar = play/pause, → = next track (host is often laptop-bound).
- Progress ring around album art; track transitions crossfade 400 ms with whoosh.
- Anonymous queue items show only colored seals matching what will be revealed later — builds memory anchors ("that cursed accordion one").
- Force Reveal guarded by same two-step confirm as phone lock.

### 2.9 Reveal Sequence — see §5 for full choreography. Wireframe essence:
Host: black stage → rank cards slam in one at a time, worst→best → suspense blackout → WINNER takeover with crown, song, owner face-reveal, confetti physics.
Phone: synchronized personal view — every player's phone shows the SAME countdown, their own rank highlighted when reached, owners revealed with a "IT WAS YOU 😱" moment for self.

### 2.10 Leaderboard (post-round, host)
```
┌──────────────────────────────────────────────┐
│  STANDINGS AFTER ROUND 2                     │
│  ① Maya ████████████ 34   ▲2                 │  ← animated bar lengths,
│  ② You  ██████████   29   ▲0                 │    delta arrows, reorder FLIP
│  ③ Sam  ████████     24   ▼1                 │    animation when ranks change
│                                              │
│  [ NEXT ROUND ▶ ]          round 3 of 5      │
└──────────────────────────────────────────────┘
```
- Rows animate position swaps (FLIP technique) with spring; point gains tick up numerically (count-up), +N floats off the row.
- Player phones mirror a compact version below a "ROUND OVER" card.

### 2.11 Winner Screen (end of game)
Host: podium (3 heights) rises with staggered springs; champion card loops a slow zoom with rotating adjectives ("AUX GOD", "CERTIFIED DJ", "TASTE DEMON"); confetti cannon ×3; play their winning song once more as credits roll. Buttons: [REMATCH same lobby] [NEW ROOM].
Phones: personalized — champions get gold treatment + "SAVE MY SETLIST" (share sheet with their winning songs); everyone else gets "REVENGE?" rematch CTA.

---

## 3. Realtime Client Architecture

### Transport & connection management
- Single WebSocket per client: `wss://…/ws?room=KZXW&token=…`. Token = signed opaque ID issued at join; nickname never travels in URL.
- Client wraps socket in a `ConnectionManager`:
  - **Heartbeat:** ping/pong every 10 s; 2 missed → mark `degraded`, show amber banner (non-blocking).
  - **Reconnect:** exponential backoff 0.5 s→8 s ±jitter, indefinite. On reconnect send `{type:'resync', token, lastSeq}`.
  - **Event seq numbers:** server stamps monotonic `seq` per room; client keeps `lastSeq` — enables idempotent resync and gap detection.
- **Resync:** server responds with full authoritative `RoomStateSnapshot` (phase, players, votes tally, submissions sealed-flag, timer deadline, leaderboard). Client diffs snapshot into stores wholesale (snapshot replaces, never merges — simpler, safe). Cost is trivial at ≤ 32 players.
- **Timer authority:** server sends phase deadlines (epoch ms), clients run local countdown clocks from deadline, never from tick streams. One `deadline` event per phase transition; drift-proof across reconnects.
- **Tab lifecycle:** `visibilitychange` → on hidden, close socket after 30 s (save battery/data); on visible, immediate resync. Phones lock during playback — this path is the norm, treat it as first-class.

### State model
```
RoomStore {
  phase: 'lobby'|'vote'|'submit'|'playback'|'reveal'|'leaderboard'|'winner'
  round, roundsTotal, category, deadline, seq
  players: Map<id,{name,color,connected,score}>
  myVotes, mySubmission:{status:'idle'|'selected'|'locked'|'sealed'}
  revealCursor: number|null   // drives §5 choreography locally
}
```
Derived values are computed signals; socket events are the ONLY writers besides local intent flags.

### Optimistic UI rules (deliberately strict — this is a party game; a wrong belief is worse than a 100 ms wait)
| Action | Policy |
|---|---|
| Category vote | ✅ Optimistic. Mark mine instantly; reconcile tally on ack; revert with inline shake if rejected (already-voted/closed). |
| Ready toggle | ✅ Optimistic. |
| Nickname/color | ❌ Server-assigned color; name confirmed on ack (dup-suffix possible). |
| Song selection (pre-lock) | ✅ Purely local until lock. |
| **Song lock/seal** | ❌ **Never optimistic.** Button shows spinner; UI enters `sealed` ONLY on server ack. Rationale: a dropped lock silently ruins someone's game; the two-step confirm masks latency naturally. |
| Host transport controls (play/pause/skip) | ⚠️ Optimistic visual state (icon flips instantly) but actual Spotify command waits for server ack; revert icon + toast on failure. Music sync errors are very visible. |
| Force reveal / next round | ❌ Waits for ack (destructive, low frequency). |
| Leaderboard/reveal | ❌ Fully server-driven; the drama depends on shared truth. |

Rule of thumb encoded in review: **optimistic only where failure is cosmetic.**

### Protocol sketch (shared types package)
Client→Server: `join{name}`, `vote{optionId}`, `select{track}`, `lock`, `ready{bool}`, `host:{play,pause,next,skipAll,forceReveal,startRound,nextRound,eject}`
Server→Client: `snapshot`, `phase{phase,deadline,payload}`, `playersDelta`, `tally`, `sealedCount`, `revealStep{rank}`, `revealWinner`, `leaderboard`, `kicked`, `error{code,msg}`
Every server message carries `seq`.

---

## 4. Component Tree

Shared primitives live in `/shared/ui`: `<Button>`, `<Card>`, `<TimerRing deadline>`, `<AvatarChip>`, `<Sheet>` (bottom sheet), `<Toast>`, `<ConfirmTap>` (two-step wrapper).

**Host app**
```
<HostApp>
 ├ <RouteLanding>            (shared)
 ├ <HostLobby>
 │   ├ <QRPanel qr url code>
 │   ├ <PlayerGrid><AvatarChip*/></PlayerGrid>
 │   └ <StartBar/>
 ├ <PlaybackScreen>
 │   ├ <CategoryBanner/>
 │   ├ <NowPlayingCard/>     (art, progress, controls)
 │   ├ <AnonymousQueue/>
 │   └ <HostActionBar/>
 ├ <RevealStage>             (§5 — its own scene manager)
 │   ├ <RankCard rank entry/>  (repeated, keyed)
 │   ├ <SuspenseVeil/>         (blackout/heartbeat layer)
 │   └ <WinnerTakeover/>
 ├ <LeaderboardBoard/>
 └ <WinnerPodium/>
```

**Player app**
```
<PlayerApp>
 ├ <JoinScreen/>
 ├ <PhoneLobby><ReadyToggle/><StatusRotator/></PhoneLobby>
 ├ <VoteScreen><OptionCard*/><TimerRing/></VoteScreen>
 ├ <SubmitScreen>
 │   ├ <SearchBar/> <ResultList><TrackRow*/></ResultList>
 │   ├ <PickBar/>             (sticky above keyboard)
 │   └ <SealOverlay/>         (post-lock takeover)
 ├ <LockedWait><PeerPressureList/></LockedWait>
 ├ <PersonalReveal>           (mirror of host reveal, self-focused)
 └ <MiniLeaderboard/> / <MyResultCard/> / <WinnerMeCard/>
```

**Store/bus layer (framework-level, not components):** `ConnectionManager`, `RoomStore`, `AudioEngine` (unlock, stingers, ticks), `Motion` helpers (FLIP util, spring presets, reduced-motion gate).

---

## 5. Reveal Choreography Spec — THE SIGNATURE MOMENT

Goal: 25–40 s of escalating theater. Worst→best count-UP (comedy first, glory last). Everything beat-synced via a single `RevealDirector` running a declarative timeline; server emits `revealStep{rank}` and clients animate locally against their clocks — network hiccups can delay a step but never desync order.

### Global rules
- Audio: all cues synthesized via WebAudio (sub-boom, riser, tick, airhorn-lite, choir-hit). Master ducking of any Spotify audio during reveal.
- Every beat fires haptic pulse on phones (`vibrate(20)` light, `(80)` heavy).
- `prefers-reduced-motion`: swap slides/shakes for fades; keep timing and audio (or silence if motion+sfx both reduced).

### Timeline (example: 6 submissions)

| Beat | T= | Host | Phones | Sound |
|---|---|---|---|---|
| Transition in | 0.0s | Playback screen dims → stage black; single spotlight cone fades in; drumroll loop starts low | Same dim; "THE VERDICT…" typographic stamp slams in (scale 3→1, blur→sharp) | drumroll loop begins, lowpass |
| Rank intro | 2.0s | Judge banner: "The Judge has deliberated 🤖⚖️" with typing dots 1.2 s | mirrored banner | blip blip blip |
| LAST PLACE | 4.0s | Card #6 slams from bottom, screen shake 200 ms on land: **"LAST PLACE 🗑️"**, witty explanation typewriters in (~1.5 s), then owner avatar cracks open egg-style → name splashes red. Their phone: full-screen "💀 IT WAS YOU" with sad-trombone | non-owner phones see same card mini; owner gets shame takeover | sub-boom + sad trombone; haptics heavy |
| Ranks 5…3 | +3.5 s each | Card slams (alternating slide L/R), explanation typewrites, owner reveal. Each card stacks upward like a totem. Crowd meter on side grows | owner highlight pulse on their phone; others watch | rising tick pitch per rank (+2 semitones each), boom on land |
| TOP 2 freeze | after #3 lands | Everything stops. Both remaining cards gray out and **blur**. Spotlight narrows. 2.5 s hold — heartbeat sound, screen edges vignette-pulse | identical freeze; both candidate owners' phones buzz twice (they know it's them!) | heartbeat 60 bpm accelerating to 90 |
| Drumroll crescendo | +3 s | "AND THE WINNER IS…" giant text, drumroll pitch/volume ramps, slight camera-shake jitter building | same | riser sweep 2.5 s |
| WINNER | drop | White flash 80 ms → winner card EXPLODES in (scale 0.2→1 spring overshoot), crown drops onto avatar with bounce, confetti cannon (canvas particles, 3 bursts staggered 300 ms), their winning song auto-plays 8 s chorus underneath, score counts up with coin sounds | Winner's phone: gold takeover "🏆 YOU WON", continuous heavy haptic 400 ms; everyone else: "🫡 Respect." card + rematch tease | choir hit + airhorn + music bed |
| Settle | +6 s | Confetti settles, leaderboard slides up beneath winner card, [NEXT ROUND] breathes | mirror | music bed continues −6 dB |

### Timing & craft details
- Between-rank pacing **accelerates** toward the top: 3.5 s → 3.0 → 2.5 → then the deliberate STOP before winner. Comedy beats get time; mid ranks move briskly.
- Explanations cap 140 chars, typewriter at 45 cps with cursor blink — never a wall of text on a TV.
- Skip affordance: host long-press reveals "skip to winner" (things run late in real parties) — executes a fast-forward timeline (all cards cascade in 1.5 s, straight to winner).
- All timings defined as data (`reveal.timeline.ts`) so backend agent and QA can unit-test the sequence and designers can tune without touching components.
- Failure mode: if a `revealStep` is late >1.5 s, RevealDirector inserts a graceful "the Judge is thinking…" filler rather than freezing mid-beat.

---

## 6. Responsive Strategy

**Two distinct products sharing one codebase — not one responsive layout.**

- **Player (phones, portrait-first):** design at 360–430 px width. `min-height: 100dvh`; everything critical in the top 60 % (keyboard reality). Sticky action zones anchored with `env(safe-area-inset-bottom)`. Landscape phones: show "rotate me 🔄" gentle overlay (game is portrait-native). Small tablets in player hands get the same layout, max-width 480 px centered column.
- **Host (desktop/tablet, landscape-first):** fluid grid, tested at 1280×720 projector through 3840×2160 TV. Typography scales with `clamp()`, tuned so the room code is readable from ~5 m (min 15 vh height for QR/code block). Touch targets ≥ 48 px because host devices are often tablets. 16:9-safe: keep critical content within center 90 % (TV overscan).
- Shared token system (`--space`, `--radius`, type scale) with per-app density overrides; components take a `surface="stage|card|control"` prop rather than media-query forks.
- Breakpoints are secondary to *role*: role is decided by entry route (`/host` vs `/r/:code`), never by screen size — a laptop can be a player, a tablet can be a host.

## 7. Empty / Error / Disconnect States

Principle: **party games die from silence.** Every degraded state gets personality, never a bare spinner.

| Situation | Behavior |
|---|---|
| Socket degraded (amber) | Slim top banner: "shaky connection… holding on 🤞". Game continues on local clock. |
| Player disconnected mid-phase | Auto-resync on return; if missed lock window → auto-pick flow with "CHICKEN" label (§2.7). Others see avatar go translucent with "zzz". |
| Player disconnected in lobby >60 s | Host chip shows ghost icon; host may eject. They can rejoin with same token (stored localStorage) reclaiming identity. |
| Full disconnect (player) | Full-screen: "You fell out of the aux 📴" + [RECONNECT] (auto-attempts in background) + room code shown for manual rejoin. Never dead-end. |
| Room closed / host left | Friendly: "The party ended 🎈" + stats recap of your night + [FIND NEW PARTY]. |
| Invalid/expired code | Join field shake + "That room's gone cold. Check the code?" |
| Spotify/auth failure (host) | Playback screen inline error card with [RETRY] + [SKIP THIS TRACK]; game never hard-blocks — reveal can proceed with "silent disco mode" disclaimer. |
| Empty states | Lobby with 0 others: host sees pulsing "Share the QR!" arrow pointing at code; search no-results: joke copy + suggestion chips; vote with 0 votes yet: bars breathe invitingly. |
| Server error surfaces | Toast pattern: emoji + human sentence + one action. Error codes mapped centrally in `errors.ts` (one place to keep copy funny and consistent). |

---

## Open items for other agents
- Backend must support: `seq`-stamped messages, epoch-ms deadlines, full-state snapshots on resync, reveal-step events, rejoin-by-token. (Protocol sketch in §3 is the contract proposal.)
- Copy/judge explanations need a voice guide — recommend the backend prompt includes length caps (≤140 chars) and a roast-tone slider.
- Accessibility pass deferred post-MVP EXCEPT: reduced-motion, contrast ≥ AA on stage text, and no information conveyed by color alone (owner reveal uses avatar+name, never just seal color).
