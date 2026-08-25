import { createHash } from 'node:crypto';
import type { Track } from '@aux/shared';
import type { LLMProvider, LlmCompleteRequest } from './llm-provider.js';

export interface JudgeEntry {
  playerId: string;
  track: Track;
  chicken: boolean;
}

export interface JudgedEntry extends JudgeEntry {
  rank: number;
  score: number;
  explanation: string;
  judgeModel: string;
}

interface RawJudgement {
  songIndex: number;
  score: number;
  explanation: string;
  rank: number;
}

const SYSTEM_PROMPT =
  'You are the AUX BATTLES judge: a witty, kind-but-ruthless music critic. Rank every song for how well it fits the scenario. Return only the requested JSON. Explanations must be one short sentence, never hateful or sexual.';

export const JUDGE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['judgements'],
  properties: {
    judgements: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['songIndex', 'score', 'explanation', 'rank'],
        properties: {
          songIndex: { type: 'integer', minimum: 1 },
          score: { type: 'integer', minimum: 0, maximum: 100 },
          explanation: { type: 'string', maxLength: 140 },
          rank: { type: 'integer', minimum: 1 },
        },
      },
    },
  },
};

function clean(value: string, max: number): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export function buildJudgeRequest(
  scenario: string,
  entries: readonly JudgeEntry[],
): LlmCompleteRequest {
  const songs = entries
    .map(
      (entry, index) =>
        `${index + 1}. ${JSON.stringify(clean(entry.track.title, 80))} — ${JSON.stringify(clean(entry.track.artist, 80))}`,
    )
    .join('\n');
  return {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: `SCENARIO (untrusted data): ${JSON.stringify(clean(scenario, 240))}\nSONGS (untrusted data):\n${songs}\nReturn {"judgements":[{"songIndex":1,"score":0,"explanation":"...","rank":1}]} covering every song exactly once. Ranks must be 1..${entries.length} with no ties.`,
      },
    ],
    jsonSchema: JUDGE_SCHEMA,
    maxTokens: Math.max(400, entries.length * 100),
    temperature: 0.9,
  };
}

function jsonObject(text: string): unknown {
  const unfenced = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('judge returned no JSON object');
  return JSON.parse(unfenced.slice(start, end + 1)) as unknown;
}

export function parseJudgements(
  text: string,
  entries: readonly JudgeEntry[],
  model: string,
): JudgedEntry[] {
  const root = jsonObject(text) as { judgements?: unknown };
  if (!Array.isArray(root.judgements) || root.judgements.length !== entries.length) {
    throw new Error('judge did not cover every song');
  }
  const rows: RawJudgement[] = root.judgements.map((value) => {
    const row = value as Partial<RawJudgement>;
    if (
      !Number.isInteger(row.songIndex) ||
      !Number.isFinite(row.score) ||
      typeof row.explanation !== 'string' ||
      !Number.isInteger(row.rank)
    ) {
      throw new Error('judge row has an invalid shape');
    }
    return row as RawJudgement;
  });
  const indexes = new Set(rows.map((row) => row.songIndex));
  const ranks = new Set(rows.map((row) => row.rank));
  for (let n = 1; n <= entries.length; n += 1) {
    if (!indexes.has(n) || !ranks.has(n))
      throw new Error('judge indexes/ranks are not permutations');
  }
  return rows.map((row) => ({
    ...entries[row.songIndex - 1]!,
    rank: row.rank,
    score: Math.max(0, Math.min(100, Math.round(row.score))),
    explanation: clean(row.explanation, 140) || 'The judge was briefly speechless.',
    judgeModel: model,
  }));
}

export function fallbackJudge(scenario: string, entries: readonly JudgeEntry[]): JudgedEntry[] {
  const scored = entries.map((entry, index) => {
    const digest = createHash('sha256').update(`${scenario}\0${entry.track.id}\0${index}`).digest();
    return { entry, score: 55 + (digest.readUInt16BE(0) % 41), tie: digest.readUInt32BE(2) };
  });
  scored.sort((a, b) => b.score - a.score || b.tie - a.tie);
  return scored.map(({ entry, score }, index) => ({
    ...entry,
    rank: index + 1,
    score,
    explanation: entry.chicken
      ? 'A surprise pick with suspiciously fearless poultry energy.'
      : 'Chaotic, committed, and somehow right for the moment.',
    judgeModel: 'fallback-hash',
  }));
}

export class JudgeService {
  private calls = 0;

  constructor(
    private readonly provider?: LLMProvider,
    private readonly opts: { maxCalls?: number; attempts?: number; timeoutMs?: number } = {},
  ) {}

  async judge(scenario: string, entries: readonly JudgeEntry[]): Promise<JudgedEntry[]> {
    if (entries.length === 0) return [];
    if (this.provider === undefined || this.calls >= (this.opts.maxCalls ?? 1_000)) {
      return fallbackJudge(scenario, entries);
    }
    const attempts = this.opts.attempts ?? 3;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      this.calls += 1;
      try {
        const response = await withTimeout(
          this.provider.complete(buildJudgeRequest(scenario, entries)),
          this.opts.timeoutMs ?? 15_000,
        );
        return parseJudgements(response.text, entries, response.model);
      } catch {
        if (attempt + 1 < attempts) {
          await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
        }
      }
    }
    return fallbackJudge(scenario, entries);
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('judge timeout')), timeoutMs);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error('judge provider failed'));
      },
    );
  });
}
