# AUX BATTLES — Task Board (non-blocking known work)

> Rule (owner approval item #4): **anonymous TODO comments in code are forbidden.**
> If code must carry a marker, it cites a task ID here, e.g. `// TODO(AUX-003): ...`
> Each entry: priority · owner · blocker · estimated complexity.

## Open

| ID | Priority | Task | Owner | Blocker | Complexity |
|----|----------|------|-------|---------|------------|
| AUX-002 | P2 | Choose production LLM vendor key (OpenRouter default) | Owner | Free-tier key sufficient for Phase 0–3 (FakeLLM used in CI) | S |
| AUX-003 | P2 | Fly.io app creation + secrets wiring (deploy happens Phase 5) | Owner | Account exists; defer until Phase 5 unless earlier smoke wanted | S |
| AUX-004 | P3 | Host-migration UX copy voice pass | Product owner | Copy drafted; needs owner tone approval | S |

## Resolved

| ID | Resolution | Date |
|----|------------|------|
| AUX-001 | Spotify catalog + live Premium/device probes P1–P8 pass; no design blocker | 2026-08-25 |
| AUX-005 | Analytics flush now awaits stream end/drain during Fastify shutdown | 2026-08-25 |
| AUX-006 | WS snapshots are FSM/orchestrator-backed, per-viewer, and restart-durable | 2026-08-25 |

## Rules
1. Code TODOs MUST reference an ID here (`TODO(AUX-XXX)`), never bare `TODO`.
2. No entry = no TODO comment allowed. Want to defer something? Add a row first.
3. P1 = blocks a phase gate. P2 = needed before Phase 5. P3 = polish.
