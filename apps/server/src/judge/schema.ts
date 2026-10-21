/**
 * Judge response schema + tolerant parsing (TDD §8).
 *
 * The structured-output contract is enforced ABOVE the LLMProvider seam
 * (D-012): whatever the vendor returns as text is parsed leniently here
 * (fenced ```json blocks, leading prose, trailing chatter) and then strictly
 * validated with Zod before it may influence a round.
 */
import { z } from 'zod';

/** How well the model knows the exact song; drives server-side uncertainty rules. */
export const SONG_KNOWLEDGE = ['known', 'artist_only', 'unknown'] as const;
export type SongKnowledge = (typeof SONG_KNOWLEDGE)[number];

/** Host screens display these lines verbatim, so links and markup are never accepted. */
const JudgeTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .refine(
    (line) => !/(https?:\/\/|www\.|<\/?[a-z][^>]*>)/i.test(line),
    'judge line contains a link or markup',
  );

export const TrackJudgementResponseSchema = z
  .object({
    knowledge: z.enum(SONG_KNOWLEDGE),
    reasons: z.array(JudgeTextSchema).length(2),
    defense: JudgeTextSchema,
    categories: z
      .object({
        scenarioFit: z.number().min(0).max(3),
        mood: z.number().min(0).max(2),
        lyrics: z.number().min(0).max(2),
        genre: z.number().min(0).max(2),
        wildcard: z.number().min(0).max(1),
      })
      .strict(),
    verdict: JudgeTextSchema,
    /** Ignored: the server owns arithmetic. Accepted because models often add it anyway. */
    totalScore: z.unknown().optional(),
  })
  .strict()
  .transform(({ totalScore: _ignored, ...value }) => value);

export type TrackJudgementResponse = z.infer<typeof TrackJudgementResponseSchema>;

export function parseTrackJudgementResponse(text: string): TrackJudgementResponse {
  if (text.length > 20_000) throw new JudgeParseError('judge response exceeds size limit');
  const parsed = TrackJudgementResponseSchema.safeParse(extractFirstJsonObject(text));
  if (!parsed.success) {
    throw new JudgeParseError(
      `track judgement failed schema validation: ${parsed.error.issues[0]?.code ?? 'unknown'}`,
    );
  }
  return parsed.data;
}

const line = { type: 'string', minLength: 1, maxLength: 160 };

/** Provider-side schema. Property order puts evidence before scores. */
export const TRACK_JUDGEMENT_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['knowledge', 'reasons', 'defense', 'categories', 'verdict'],
  properties: {
    knowledge: { type: 'string', enum: [...SONG_KNOWLEDGE] },
    reasons: { type: 'array', minItems: 2, maxItems: 2, items: line },
    defense: line,
    categories: {
      type: 'object',
      additionalProperties: false,
      required: ['scenarioFit', 'mood', 'lyrics', 'genre', 'wildcard'],
      properties: {
        scenarioFit: { type: 'number', minimum: 0, maximum: 3 },
        mood: { type: 'number', minimum: 0, maximum: 2 },
        lyrics: { type: 'number', minimum: 0, maximum: 2 },
        genre: { type: 'number', minimum: 0, maximum: 2 },
        wildcard: { type: 'number', minimum: 0, maximum: 1 },
      },
    },
    verdict: line,
  },
};

export class JudgeParseError extends Error {}

/**
 * Extract the first balanced JSON object from arbitrary text — tolerates
 * ```fenced``` payloads and prose around the object. Throws JudgeParseError
 * when no parseable object exists.
 */
export function extractFirstJsonObject(text: string): unknown {
  const unfenced = text.replace(/```(?:json)?/gi, '');
  const start = unfenced.indexOf('{');
  if (start < 0) throw new JudgeParseError('no JSON object in judge response');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < unfenced.length; i += 1) {
    const ch = unfenced[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(unfenced.slice(start, i + 1)) as unknown;
        } catch {
          throw new JudgeParseError('judge response is not valid JSON');
        }
      }
    }
  }
  throw new JudgeParseError('unterminated JSON object in judge response');
}
