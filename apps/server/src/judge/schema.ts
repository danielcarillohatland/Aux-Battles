/**
 * Judge response schema + tolerant parsing (TDD §8).
 *
 * The structured-output contract is enforced ABOVE the LLMProvider seam
 * (D-012): whatever the vendor returns as text is parsed leniently here
 * (fenced ```json blocks, leading prose, trailing chatter) and then strictly
 * validated with Zod before it may influence a round.
 */
import { z } from 'zod';

export const JudgementRowSchema = z.object({
  songIndex: z.number().int().min(0),
  score: z.number().int().min(0).max(100),
  explanation: z.string().min(1).max(280),
});

export const JudgementSchema = z.object({
  judgements: z.array(JudgementRowSchema),
});

export type JudgementRow = z.infer<typeof JudgementRowSchema>;
export type JudgementList = z.infer<typeof JudgementSchema>;

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

/**
 * Parse raw LLM text into validated judgements.
 * @throws JudgeParseError when extraction or schema validation fails.
 */
export function parseJudgeResponse(text: string): JudgementList {
  const raw = extractFirstJsonObject(text);
  const parsed = JudgementSchema.safeParse(raw);
  if (!parsed.success) {
    throw new JudgeParseError(
      `judge response failed schema validation: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
    );
  }
  return parsed.data;
}

/** Vendor-neutral structured-output hint handed to providers that support it. */
export const JUDGE_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['judgements'],
  properties: {
    judgements: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['songIndex', 'score', 'explanation'],
        properties: {
          songIndex: { type: 'integer', minimum: 0 },
          score: { type: 'integer', minimum: 0, maximum: 100 },
          explanation: { type: 'string', minLength: 1, maxLength: 280 },
        },
      },
    },
  },
};
