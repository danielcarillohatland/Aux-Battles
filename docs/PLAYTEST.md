# AUX BATTLES — Structured Playtesting Loop

> The MVP's success criterion is *"would people voluntarily play another round?"*
> That question is answered here, not in code reviews. First structured playtest due during **Phase 5** (loop activates after Phase 2).

## When to playtest
- **After Phase 2** (realtime core): dry-run joining/reconnecting with 3+ friends — no judging yet. Focus: does joining feel instant? do reconnects confuse people?
- **Phase 5 gate**: full loop with 5–10 players, at least one non-engineer host.
- **Post-MVP**: every meaningful change, same questions, comparable numbers.

## Session protocol
1. Fresh room, real phones, host device = laptop/TV as intended.
2. Facilitator says nothing about rules — observes whether players self-explain.
3. Record: join start→playing time per player, per-phase wall clock, every question asked aloud.
4. After 3 rounds: run the questionnaire below out loud, capture verbatim quotes.
5. Watch for the moment someone says "one more round" — that's the metric.

## Questionnaire (ask every player)
1. Did everyone understand the rules without explanation? *(Y/N + what confused you)*
2. How long did joining take from your perspective? *(instant / fine / slow)*
3. Was song selection stressful or fun? *(scale 1–5 + why)*
4. Was the AI judging funny and believable? *(quote your favorite/least favorite roast)*
5. Were reveal timings too long, too short, or right? *(per beat: drumroll / countdown / top-2 freeze)*
6. Did you ever want to skip animations? *(when?)*
7. Did you want to play another round? *(the money question — honest Y/N)*
8. Which scenario produced the best battle? *(feeds scenario bank)*
9. Anything confusing on your phone specifically?

## Session log template
```
### Playtest #N — <date> — <location>
Players: <n> (ages/tech-comfort mix) · Host device: <x> · Rounds played: <n>
Join time range: <a>–<b>s · Avg round time: <t>
Q1 comprehension: <n>/<n> unaided
Q3 selection fun: <avg>/5
Q4 judge funny: <quotes>
Q5 reveal pacing: <verdict>
Q7 another round: <n>/<n> YES
Top complaints: ...
Top delights: ...
Actions taken: (link to TODO.md IDs)
```

## Metrics cross-check (analytics hooks, D-010)
Compare felt experience against instrumented truth: rooms created, games completed, avg players, avg rounds/game, avg round time, host disconnects, reconnect counts, AI failures, Spotify failures, manual-playback usage. Divergence between "players said it was smooth" and reconnect/failure counts = investigation trigger.

## Kill criteria (pause feature work if violated)
- Q7 below 60% yes across a session of 6+ → stop, diagnose, fix before building anything else.
- Join time >15 s median → Phase 1 regression, fix immediately.
- Judge explanations rated "robotic" by majority → prompt overhaul before more scenarios.
