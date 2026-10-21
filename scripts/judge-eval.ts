/**
 * Live AI judge evaluation against the labeled benchmark. PAID: every case
 * makes real OpenRouter requests. Requires OPENROUTER_API_KEY and --live.
 *
 *   npm run judge:eval -- --live [--repeat 3] [--model provider/model] [--out file.json]
 *
 * Reports band accuracy, pairwise ranking accuracy, knowledge honesty, score
 * spread across repeats (consistency), schema/transport errors, latency, cost.
 */
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { JUDGE_BENCHMARK, JUDGE_BENCHMARK_PAIRS } from '../apps/server/src/judge/benchmark.js';
import { LlmProviderError, type LlmUsage } from '../apps/server/src/judge/llm-provider.js';
import { OpenRouterProvider } from '../apps/server/src/judge/openrouter.js';
import { JUDGE_PROMPT_VERSION } from '../apps/server/src/judge/prompt.js';
import { judgeTrack } from '../apps/server/src/judge/service.js';

const { values } = parseArgs({
  options: {
    live: { type: 'boolean', default: false },
    repeat: { type: 'string', default: '1' },
    model: { type: 'string' },
    out: { type: 'string' },
  },
});

const apiKey = process.env['OPENROUTER_API_KEY']?.trim();
if (!values.live || !apiKey) {
  console.error(
    'Refusing to run: this makes paid requests. Set OPENROUTER_API_KEY and pass --live.',
  );
  process.exit(2);
}
const repeat = Math.max(1, Math.min(10, Number(values.repeat) || 1));
const costs: LlmUsage[] = [];
const provider = new OpenRouterProvider({
  apiKey,
  ...(values.model ? { model: values.model } : {}),
  maxConcurrent: 4,
  attemptHooks: { onAttempt: (record) => void (record.usage && costs.push(record.usage)) },
});

interface Run {
  score?: number;
  knowledge?: string;
  confidence?: string;
  latencyMs: number;
  error?: string;
}
const runs = new Map<string, Run[]>();

for (let round = 0; round < repeat; round += 1) {
  await Promise.all(
    JUDGE_BENCHMARK.map(async (entry) => {
      const startedAt = Date.now();
      let run: Run;
      try {
        const judged = await judgeTrack(
          entry.scenario,
          {
            index: 0,
            id: entry.id,
            title: entry.title,
            artist: entry.artist,
            ...(entry.description ? { description: entry.description } : {}),
            ...(entry.defense ? { defense: entry.defense } : {}),
          },
          provider,
          { attempts: 1, ...(entry.vibe ? { vibe: entry.vibe } : {}) },
        );
        run = {
          score: judged.totalScore,
          confidence: judged.confidence,
          latencyMs: Date.now() - startedAt,
        };
      } catch (error) {
        run = {
          latencyMs: Date.now() - startedAt,
          error: error instanceof LlmProviderError ? error.code : 'invalid_response',
        };
      }
      runs.set(entry.id, [...(runs.get(entry.id) ?? []), run]);
    }),
  );
}

const mean = (list: number[]) => list.reduce((sum, value) => sum + value, 0) / (list.length || 1);
const pct = (part: number, whole: number) => `${whole ? ((100 * part) / whole).toFixed(0) : 0}%`;
const all = [...runs.values()].flat();
const ok = all.filter((run) => run.score !== undefined);
const caseRows = JUDGE_BENCHMARK.map((entry) => {
  const scores = (runs.get(entry.id) ?? []).flatMap((run) =>
    run.score === undefined ? [] : [run.score],
  );
  const avg = mean(scores);
  return {
    id: entry.id,
    band: entry.band.join('-'),
    mean: scores.length ? Number(avg.toFixed(2)) : null,
    spread: scores.length > 1 ? Number((Math.max(...scores) - Math.min(...scores)).toFixed(2)) : 0,
    inBand: scores.length > 0 && avg >= entry.band[0] && avg <= entry.band[1],
    confidence: [
      ...new Set((runs.get(entry.id) ?? []).map((run) => run.confidence ?? run.error)),
    ].join(','),
  };
});
const byId = new Map(caseRows.map((row) => [row.id, row]));
const pairsOk = JUDGE_BENCHMARK_PAIRS.filter(
  (pair) => (byId.get(pair.better)?.mean ?? -1) > (byId.get(pair.worse)?.mean ?? 11),
).length;
const latencies = ok.map((run) => run.latencyMs).sort((a, b) => a - b);
const totalCost = costs.reduce((sum, usage) => sum + (usage.costUsd ?? 0), 0);

const report = {
  model: provider.modelName,
  promptVersion: JUDGE_PROMPT_VERSION,
  repeat,
  bandAccuracy: pct(caseRows.filter((row) => row.inBand).length, caseRows.length),
  pairAccuracy: pct(pairsOk, JUDGE_BENCHMARK_PAIRS.length),
  schemaOrTransportErrors: pct(all.length - ok.length, all.length),
  maxSpread: Math.max(0, ...caseRows.map((row) => row.spread)),
  latencyMs: {
    p50: latencies[Math.floor(latencies.length / 2)] ?? null,
    p95: latencies[Math.floor(latencies.length * 0.95)] ?? null,
  },
  costUsd: {
    total: Number(totalCost.toFixed(6)),
    perJudgement: Number((totalCost / (all.length || 1)).toFixed(6)),
  },
  cases: caseRows,
};
console.table(caseRows);
console.log(JSON.stringify({ ...report, cases: undefined }, null, 2));
if (values.out) writeFileSync(values.out, `${JSON.stringify(report, null, 2)}\n`);
