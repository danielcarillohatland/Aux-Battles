# AI judge setup and operation

The judge uses the scenario, song title, artist, optional catalog description, and the player's defense. It uses existing song knowledge; **it does not hear, download, or analyze the recording**. Unknown songs must be described as uncertain. Do not market this implementation as audio analysis.

## Start an AI game

**Open access (default, `AUX_AI_ACCESS=open`).** The project runs as a free, non-commercial party site. Any host who picks "DJ AUX" on the start page gets an AI-judged game of up to five rounds, with no sign-in or purchase. Players confirm that their picks and defenses are sent to the AI provider when they join. Cost is bounded by `AUX_OPEN_AI_DAILY_GAMES` (site-wide free games per UTC day) plus the durable daily and monthly budgets below. When the daily cap is reached, new games start with crowd voting. A failed AI round falls back to crowd voting for that round only, and the next round tries the AI again.

**Paid mode (`AUX_AI_ACCESS=account`).** A host signs in through the native iOS Sign in with Apple flow and uses one host game credit when starting a game. Friends join free. One credit covers up to five rounds. Crowd practice runs without sign-in or a paid model. Server credentials, verified identity, StoreKit setup, durable account storage, purchase recovery, and budgets are documented in [Host accounts and AI game packs](billing.md). Browser Apple sign-in is not implemented.

Set these server-only values in the existing `.env` for local development, or the deployment's secret store, then restart:

```dotenv
OPENROUTER_API_KEY=<your OpenRouter key>
OPENROUTER_MODEL=google/gemini-3.1-flash-lite
AUX_LLM_MAX_CALLS=1000
AUX_LLM_MAX_CONCURRENT=8
AUX_AI_ATTEMPT_MAX_MICROS=10000
AUX_AI_ACCESS=open
AUX_OPEN_AI_DAILY_GAMES=30
AUX_AI_DAILY_BUDGET_MICROS=500000
AUX_AI_MONTHLY_BUDGET_MICROS=3000000
```

The account needs available credits and access to the model. An empty model uses the default above; an empty key makes AI unavailable. Existing `.env` values take precedence over `.env.example`. Never put the key in frontend/Vite configuration or a mobile bundle. A configured key is not proof that it is funded or working.

The default was present in the [OpenRouter model catalog](https://openrouter.ai/api/v1/models) on 2026-09-28 with structured-output support. Check current availability and pricing before launch or a model change. Requests use a single `/chat/completions` endpoint, the strict rubric JSON schema, and a provider that supports the required parameters. See [OpenRouter structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs).

## One round, one scoring mode

Judging starts in the background during playback. Each song receives the same rubric, prompt version (`round-fit-v5`), and anonymous round context. Calls remain per-song, with progress reported as songs complete. Song metadata and defenses are bounded, quoted, anonymous, and treated as untrusted data.

**No song's AI score is exposed until every song has a valid result from the same model.** Once complete, the host reveals each score and one-sentence verdict, with the rubric and reasoning available in an expandable section. Refreshing, advancing, or reconnecting uses cached results; it does not request another judgement. If an incomplete AI round is recovered after a server restart, it switches to crowd voting instead of repeating requests that may already have been billed.

## The brief: one agreed feeling per scene

Every catalogue scene carries a `vibe`, the single feeling the song must create (for example "Slow-dancing with your crush when the song suddenly ends" → *Painfully awkward, the silence is deafening*). The host screen, the player's pick screen and the crowd ballot all show it, so the room argues about the same target. The judge receives it as the **BRIEF** and scores scenario fit and mood against it: a song that suits the situation but delivers another feeling (romantic instead of mortifying) loses points there. Custom prompts have no brief; the judge then picks the most obvious feeling for the scene.

## What the model decides and what code decides

| Step | Owner |
| --- | --- |
| Is AI allowed for this room/round (credit, budget, consent, configuration)? | Code |
| Prompt construction, quoting and length limits for untrusted text | Code |
| Reasons, defense note, verdict, rubric category scores, song-knowledge self-report | Model |
| Schema validation (exact keys, ranges, two reasons, 160-character lines, no links or markup) | Code |
| Total score (sum of categories; any model-supplied total is ignored) | Code |
| Uncertainty rules (below) and the reported confidence | Code |
| Ranking, ties, rank points, leaderboard | Code |
| Whole-round failure → crowd voting and one idempotent credit refund | Code |

The model returns `knowledge`: `known` (it confidently recognizes this exact song), `artist_only`, or `unknown`. Because the judge receives metadata, not audio, the server then applies fixed rules so a guess cannot move a score:

- `known` → categories are used as returned; confidence `high`.
- `artist_only`, or `unknown` with a catalog description → lyrics is pinned to neutral (1/2); confidence `medium`.
- `unknown` without a description → mood, lyrics and genre are pinned to neutral (1/2 each); confidence `low`. Scenario fit (judged from title, artist and scenario) and wildcard still count.

Neutral pinning works both ways: an obscure song is neither inflated nor punished for being unknown. Low-confidence results carry a visible note on the host and player screens.

Ranking sorts by total, then scenario fit (the heaviest rubric line). Songs equal on both share a place and the same rank points, matching crowd voting; there is no hidden track-ID or random tiebreak.

## Reliability limits

Each song has at most two attempts, a 12-second service deadline per attempt, and at most 800 output tokens. An independent 30-second round deadline bounds the whole batch, including queueing. Cancellation aborts the real transport. Authentication, funding, invalid request/model, queue capacity, accounting, and budget errors do not retry. Transient network/server failures and invalid output may retry once. Short `Retry-After` delays are respected; a delay over two seconds ends the AI attempt. Three consecutive provider transport failures open a 30-second circuit breaker.

Any failed song, changed model, invalid final output, accounting failure, or exceeded round deadline discards **all** partial AI scores. There is no deterministic fallback scorer and no mixture of AI and invented scores: the round switches to crowd voting. An outage reports the round failure once to the billing service, which restores the host's game credit idempotently. That refunded game continues with crowd voting and cannot resume paid calls. Intentional crowd practice does not trigger a refund or a model request. The legacy `fallback-hash` identifier is still recognized in persisted data from older versions; new rounds never produce it.

## Model choice

The default is `google/gemini-3.1-flash-lite` through OpenRouter: the task is short, structured, per-song classification with a strict JSON schema, so a fast low-cost model with native structured outputs fits better than a large reasoning model (a party cannot wait 20 seconds per song, and per-round cost is multiplied by every song). A multi-model or verifier pipeline was deliberately not added: the uncertainty rules and whole-round validation remove the main failure modes without doubling calls. Re-evaluate with the benchmark below before changing the model; `OPENROUTER_MODEL` switches it without code changes.

## Benchmark and evaluation

`apps/server/src/judge/benchmark.ts` holds labeled cases (obvious fits, clashes, irony, title-only matches, unknown songs, a catalog original, defense effects, prompt injection in the defense and in song metadata) with score bands and expected orderings.

- `npm test` runs the offline regression suite (`judge-benchmark.test.ts`, `judge-schema.test.ts`): prompt invariants for every case, the full malformed/adversarial response matrix, and the uncertainty rules. No network, no cost.
- `npm run judge:eval -- --live [--repeat 3] [--model provider/model] [--out report.json]` runs the benchmark against the real provider and reports band accuracy, pairwise ranking accuracy, score spread across repeats, schema/transport error rate, p50/p95 latency, and cost. It is **paid** and refuses to run without `OPENROUTER_API_KEY` and `--live`.

## Crowd voting

Crowd voting is an explicit scoring mode, available for practice and when AI is unavailable. The host screen announces the vote; eligible players vote on their phones for another submitted song.

- One immutable ballot per authenticated, eligible player. A player must have a submission and another player's song to choose. Self-votes, outsiders, changed votes, and stale round IDs are rejected server-side. Repeating the identical accepted vote is idempotent.
- Ballots contain opaque option IDs and song metadata, with the viewer's own submission removed. Owners, individual votes, and per-song running totals remain private. Reconnecting restores whether that player already voted.
- Voting closes automatically after 45 seconds or when all eligible ballots arrive. The host can close once everyone has voted, the deadline has passed, or every remaining voter is disconnected. A host cannot cut off connected players immediately.
- Most votes wins. Equal totals share the same place and rank points; there is no hidden random tiebreak. Result percentages are **vote share**, not AI ratings out of ten. Results identify their source as `crowd-vote-v1`.
- A round with no voters or no submitted votes advances without inventing a winner or awarding points. It is marked `crowd-no-votes`. The rule also covers a one-player fixture, so it cannot get stuck waiting for a self-vote.

Ballots, accepted votes, deadlines, mode, and final results ride the room checkpoint. Partial AI results remain server-private. The billing ledger and game checkpoint must use durable storage for production; see [billing storage requirements](billing.md).

## Spending and metrics

The provider reserves a unique attempt in the durable ledger **before each possible paid dispatch**, including retries. Atomic reservations enforce daily and monthly budgets across database connections. The configured per-attempt reserve must cover worst-case input/output pricing for the selected model; it is not a price quote or a retail game price. Actual usage reconciles the reservation; absent or invalid cost data retains the full reservation. An authorized attempt cancelled before dispatch can release its reservation at zero cost. Failed accounting stops further AI calls instead of bypassing the ledger.

OpenRouter returns `prompt_tokens`, `completion_tokens`, `total_tokens`, and `usage.cost` automatically in nonstreaming responses. The adapter accepts only finite, nonnegative numerical costs and safe integer token counts. It never treats missing usage as zero. The old `usage: { include: true }` flag is deprecated and is not sent. See [OpenRouter usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting).

Attempt records contain room/round context, a unique attempt ID, requested model, prompt version, dispatch status, transport outcome, elapsed milliseconds, safe error code, and reported usage. They contain no keys, raw prompts, or provider response bodies. Transport success and valid judgement are separate: locally invalid JSON is reported as a validation failure even if the HTTP request succeeded. Inspect aggregate latency, provider errors, validation errors, costs, model version, and prompt version when evaluating a model change.

`AUX_LLM_MAX_CALLS` is an additional process-wide request-count guard, including retries. It resets on restart and does not replace the durable money budgets. Zero prevents dispatch. `AUX_LLM_MAX_CONCURRENT` limits active requests; up to 64 additional requests wait in arrival order. Queueing shares the deadline, expired callers never dispatch, and a full queue switches the round to crowd voting. Also set an independent provider/key spending cap.

## Release checks

Regression tests mock HTTP and do not make purchases or paid AI calls. They cover the benchmark prompt invariants and response matrix, score privacy, whole-round failure/model consistency, attempt accounting and caps, stale jobs, persisted ballots, self-vote/replay rejection, tied ranks, and unvoted rounds. They do not prove that deployed credentials are funded or that a model meets the product's quality and latency targets.

Before release, run an explicitly funded staging game with familiar and unfamiliar songs, verify real AI results and usage records, then exercise invalid-key, no-credit, outage, restart, and exhausted-budget cases. Verify the game credit returns once and every device reaches the same crowd ballot. Calibrate a representative collection of scenarios, languages, genres, and unknown tracks; compare score distributions and human preference, not just schema validity.

Publish the disclosure and consent flow for sending song choices and defenses to OpenRouter and its selected provider. Review retention settings, support/refund policy, and intended launch territories. Music playback rights remain a separate release requirement; functioning AI judging grants no playback rights.
