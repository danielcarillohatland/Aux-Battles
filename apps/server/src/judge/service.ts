/**
 * Judge service (TDD §8 / D-012): bounded, validated LLM calls per track over
 * the LLMProvider seam. A failure rejects; the orchestrator then switches the
 * whole round to crowd voting instead of mixing in invented scores.
 */
import type { JudgeConfidence, JudgingCategories, TrackJudgement } from '@aux/shared';
import { LlmProviderError, type LLMProvider, type LlmRequestContext } from './llm-provider.js';
import { buildTrackJudgeMessages, type JudgeSong } from './prompt.js';
import {
  JudgeParseError,
  parseTrackJudgementResponse,
  TRACK_JUDGEMENT_JSON_SCHEMA,
  type SongKnowledge,
} from './schema.js';

export interface JudgeRoundSong extends JudgeSong {
  /** Stable track identifier; kept separate from the anonymous prompt. */
  id: string;
}

export interface JudgeOptions {
  /** Validation attempts before rejecting (default 2, maximum 3). */
  attempts?: number;
  context?: LlmRequestContext;
  /** The scenario's agreed feeling, judged as the brief (absent for custom prompts). */
  vibe?: string;
  signal?: AbortSignal;
  /** Per-call provider timeout in ms (default 12_000, maximum 15_000). */
  timeoutMs?: number;
  /** Base backoff in ms between attempts (default 250, doubles per attempt). */
  backoffMs?: number;
  onFailure?: (context: {
    attempt: number;
    provider: string;
    model: string;
    error: unknown;
  }) => void;
}

export interface JudgedTrack extends TrackJudgement {
  judgeModel: string;
  confidence: JudgeConfidence;
}

function withTimeout<T>(
  start: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parent?: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const signal = parent ? AbortSignal.any([controller.signal, parent]) : controller.signal;
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(
        parent?.aborted
          ? new LlmProviderError('cancelled', 'Judge round was cancelled', false)
          : new LlmProviderError('timeout', 'AI judge deadline exceeded', true),
      );
    };
    signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    timer.unref();
    // Catch synchronous adapter failures as well as rejected promises.
    Promise.resolve()
      .then(() => {
        if (signal.aborted)
          throw new LlmProviderError('cancelled', 'Judge round was cancelled', false);
        return start(signal);
      })
      .then(
        (value) => {
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          reject(error instanceof Error ? error : new Error('judge provider failed'));
        },
      );
  });
}

function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
  return value === undefined || !Number.isFinite(value)
    ? fallback
    : Math.max(min, Math.min(max, Math.floor(value)));
}

/** Join the bullets into one prose block for players and persisted results. */
export function composeExplanation(
  reasons: readonly string[],
  defenseNote: string,
  verdict: string,
): string {
  return `${reasons.join(' ')} ${defenseNote} Verdict: ${verdict}`.slice(0, 700);
}

const NEUTRAL = 1;

/**
 * Deterministic uncertainty rules (round-fit-v3). The model cannot hear audio,
 * so categories it admits it cannot know are pinned to neutral by code, not by
 * trust in the prompt. A catalog description supplies the sound, never lyrics.
 */
export function applyKnowledgeRules(
  categories: JudgingCategories,
  knowledge: SongKnowledge,
  hasDescription: boolean,
): { categories: JudgingCategories; confidence: JudgeConfidence } {
  if (knowledge === 'known') return { categories, confidence: 'high' };
  const pinned = { ...categories, lyrics: NEUTRAL };
  if (knowledge === 'unknown' && !hasDescription) {
    return { categories: { ...pinned, mood: NEUTRAL, genre: NEUTRAL }, confidence: 'low' };
  }
  return { categories: pinned, confidence: 'medium' };
}

export function sumCategories(categories: JudgingCategories): number {
  return Math.round(Object.values(categories).reduce((sum, score) => sum + score, 0) * 10) / 10;
}

/** Judge one anonymous track independently; rejects once attempts are exhausted. */
export async function judgeTrack(
  scenario: string,
  song: JudgeRoundSong,
  llm: LLMProvider,
  opts: JudgeOptions = {},
): Promise<JudgedTrack> {
  let lastError: unknown;
  const attempts = bounded(opts.attempts, 2, 1, 3);
  const timeoutMs = bounded(opts.timeoutMs, 12_000, 1, 15_000);
  const backoffMs = bounded(opts.backoffMs, 250, 0, 1_000);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await withTimeout(
        (signal) =>
          llm.complete({
            messages: buildTrackJudgeMessages(scenario, song, opts.vibe),
            jsonSchema: TRACK_JUDGEMENT_JSON_SCHEMA,
            maxTokens: 800,
            temperature: 0.2,
            ...(opts.context ? { context: opts.context } : {}),
            signal,
          }),
        timeoutMs,
        opts.signal,
      );
      const parsed = parseTrackJudgementResponse(response.text);
      const { categories, confidence } = applyKnowledgeRules(
        parsed.categories,
        parsed.knowledge,
        Boolean(song.description?.trim()),
      );
      const reasons = parsed.reasons;
      const defenseNote = parsed.defense;
      const verdict = parsed.verdict;
      return {
        totalScore: sumCategories(categories),
        categories,
        confidence,
        reasons,
        defenseNote,
        verdict,
        explanation: composeExplanation(reasons, defenseNote, verdict),
        judgeModel: response.model,
      };
    } catch (error) {
      lastError = error;
      try {
        if (error instanceof JudgeParseError) llm.reportInvalidResponse?.();
        opts.onFailure?.({
          attempt: attempt + 1,
          provider: llm.providerName ?? llm.constructor.name ?? 'configured-provider',
          model: llm.modelName ?? 'configured-model',
          error,
        });
      } catch {
        // Observability failures must never strand a game.
      }
      if (error instanceof LlmProviderError && !error.retryable) break;
      const delay = Math.max(
        backoffMs * 2 ** attempt,
        error instanceof LlmProviderError ? (error.retryAfterMs ?? 0) : 0,
      );
      // Do not retry earlier than Retry-After, or keep a party waiting for a long cooldown.
      if (delay > 2_000) break;
      if (attempt + 1 < attempts && delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError ?? new LlmProviderError('unavailable', 'AI judge is unavailable', false);
}
