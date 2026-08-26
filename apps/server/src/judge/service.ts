/**
 * JudgeService core (TDD §8 / D-012): ONE batched LLM call per round,
 * schema-validated, with a deterministic fallback so an LLM outage never
 * stalls a party. Depends only on the LLMProvider seam — game logic never
 * imports a vendor SDK.
 *
 * Semantics:
 *  - 3 attempts with exponential backoff; each response must cover every
 *    songIndex exactly once or the attempt is discarded.
 *  - Scores are clamped to 0..100 (defense in depth on top of Zod).
 *  - Ranks are DERIVED server-side by score sort (stable tiebreak: lower
 *    songIndex wins) — the model never gets to declare ranks.
 *  - After all attempts fail → hash-seeded deterministic judge tagged
 *    `judge_model='fallback-hash'`.
 */
import { createHash } from 'node:crypto';
import type { LLMProvider, LlmCompleteRequest } from './llm-provider.js';
import { buildJudgeMessages, type JudgeSong } from './prompt.js';
import { JUDGE_JSON_SCHEMA, parseJudgeResponse } from './schema.js';

export interface JudgeRoundSong extends JudgeSong {
  /** Stable id — seeds the deterministic fallback score. */
  id: string;
}

export interface JudgeResult {
  songIndex: number;
  score: number;
  rank: number;
  explanation: string;
  judgeModel: string;
}

export interface JudgeRoundOutput {
  results: JudgeResult[];
  model: string;
}

export interface JudgeRoundInput {
  scenario: string;
  songs: readonly JudgeRoundSong[];
}

export interface JudgeOptions {
  /** Validation attempts before falling back (default 3). */
  attempts?: number;
  /** Per-call provider timeout in ms (default 15_000). */
  timeoutMs?: number;
  /** Base backoff in ms between attempts (default 250, doubles per attempt). */
  backoffMs?: number;
}

export const FALLBACK_MODEL = 'fallback-hash';

const FALLBACK_EXPLANATIONS = [
  'Chaotic, committed, and somehow exactly right for this moment.',
  'A left-field pick that shouldn\u2019t work — and absolutely does.',
  'Reads the room like a headline reads the news: perfectly.',
  'Main-character energy in audio form; the scenario never stood a chance.',
  'Bold, slightly unhinged, impossible to argue with.',
  'The kind of song that makes the moment feel scripted.',
] as const;

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

/** Rank results by score desc; stable tiebreak keeps the earlier songIndex ahead. */
function deriveRanks<T extends { songIndex: number; score: number }>(
  rows: readonly T[],
): Map<number, number> {
  const ordered = [...rows].sort((a, b) => b.score - a.score || a.songIndex - b.songIndex);
  const ranks = new Map<number, number>();
  ordered.forEach((row, position) => ranks.set(row.songIndex, position + 1));
  return ranks;
}

function fallbackJudge(songs: readonly JudgeRoundSong[]): JudgeResult[] {
  const scored = songs.map((song) => {
    // Hash-seeded from the song id alone → same id always scores the same.
    const digest = createHash('sha256').update(song.id).digest();
    return {
      songIndex: song.index,
      score: clampScore(40 + (digest.readUInt32BE(0) % 55)),
      explanation: FALLBACK_EXPLANATIONS[digest.readUInt32BE(4) % FALLBACK_EXPLANATIONS.length]!,
    };
  });
  const ranks = deriveRanks(scored);
  return scored.map(({ songIndex, score, explanation }) => ({
    songIndex,
    score,
    rank: ranks.get(songIndex)!,
    explanation,
    judgeModel: FALLBACK_MODEL,
  }));
}

function buildRequest(scenario: string, songs: readonly JudgeRoundSong[]): LlmCompleteRequest {
  return {
    messages: buildJudgeMessages(scenario, songs),
    jsonSchema: JUDGE_JSON_SCHEMA,
    maxTokens: Math.max(400, songs.length * 120),
    temperature: 0.9,
  };
}

function validateCoverage(
  rows: readonly { songIndex: number }[],
  songs: readonly JudgeRoundSong[],
): void {
  if (rows.length !== songs.length) throw new Error('judge did not cover every song');
  const seen = new Set<number>();
  for (const row of rows) {
    if (seen.has(row.songIndex)) throw new Error(`duplicate judgement for song ${row.songIndex}`);
    seen.add(row.songIndex);
  }
  for (const song of songs) {
    if (!seen.has(song.index)) throw new Error(`missing judgement for song ${song.index}`);
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

/**
 * Judge one round: single batched call, validated, retried, fallback-backed.
 * Never throws for provider/validation failures — worst case is the
 * deterministic fallback ranking.
 */
export async function judgeRound(
  { scenario, songs }: JudgeRoundInput,
  llm: LLMProvider | undefined,
  opts: JudgeOptions = {},
): Promise<JudgeRoundOutput> {
  if (songs.length === 0 || llm === undefined) {
    return { results: fallbackJudge(songs), model: FALLBACK_MODEL };
  }
  const attempts = opts.attempts ?? 3;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const backoffMs = opts.backoffMs ?? 250;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await withTimeout(llm.complete(buildRequest(scenario, songs)), timeoutMs);
      const parsed = parseJudgeResponse(response.text);
      validateCoverage(parsed.judgements, songs);
      const clamped = parsed.judgements.map((row) => ({
        songIndex: row.songIndex,
        score: clampScore(row.score),
        explanation: row.explanation,
      }));
      const ranks = deriveRanks(clamped);
      return {
        results: clamped.map(({ songIndex, score, explanation }) => ({
          songIndex,
          score,
          rank: ranks.get(songIndex)!,
          explanation,
          judgeModel: response.model,
        })),
        model: response.model,
      };
    } catch {
      if (attempt + 1 < attempts) {
        await new Promise((resolve) => setTimeout(resolve, backoffMs * 2 ** attempt));
      }
    }
  }
  return { results: fallbackJudge(songs), model: FALLBACK_MODEL };
}
