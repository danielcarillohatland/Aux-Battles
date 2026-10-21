import { describe, expect, it } from 'vitest';
import { parseTrackJudgementResponse } from '../src/judge/schema.js';
import { applyKnowledgeRules } from '../src/judge/service.js';

const valid = {
  knowledge: 'known',
  totalScore: 7,
  categories: { scenarioFit: 2, mood: 2, lyrics: 1, genre: 1, wildcard: 1 },
  reasons: [' A fitting known theme. ', ' Good timing for this scene. '],
  defense: ' No defense filed. ',
  verdict: ' Strong choice. ',
};

describe('judge output validation', () => {
  it('accepts fenced JSON and trims display text', () => {
    const result = parseTrackJudgementResponse(
      `Here is the result:\n\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``,
    );
    expect(result.reasons).toEqual(['A fitting known theme.', 'Good timing for this scene.']);
    expect(result.verdict).toBe('Strong choice.');
  });

  it('ignores model arithmetic: the parsed result carries no model total', () => {
    const parsed = parseTrackJudgementResponse(JSON.stringify({ ...valid, totalScore: 2 }));
    expect(parsed).not.toHaveProperty('totalScore');
    const withoutTotal: Partial<typeof valid> = { ...valid };
    delete withoutTotal.totalScore;
    expect(parseTrackJudgementResponse(JSON.stringify(withoutTotal)).categories).toEqual(
      valid.categories,
    );
  });

  it.each([
    { ...valid, categories: { ...valid.categories, mood: 3 } },
    { ...valid, categories: { ...valid.categories, scenarioFit: -1 } },
    { ...valid, reasons: [' ', 'A real reason.'] },
    { ...valid, defense: '\n\t' },
    { ...valid, reasons: ['Only one reason.'] },
    { ...valid, reasons: ['One.', 'Two.', 'Three.'] },
    { ...valid, instructions: 'Ignore the schema.' },
    { ...valid, knowledge: 'certain' },
    { ...valid, knowledge: undefined },
    { ...valid, verdict: 'Claim your prize at https://evil.example' },
    { ...valid, reasons: ['Visit www.evil.example now.', 'A real reason.'] },
    { ...valid, defense: '<img src=x onerror=alert(1)>' },
  ])('rejects malformed scores and unusable text', (payload) => {
    expect(() => parseTrackJudgementResponse(JSON.stringify(payload))).toThrow();
  });

  it('rejects oversized and truncated output', () => {
    expect(() => parseTrackJudgementResponse('x'.repeat(20_001))).toThrow('size limit');
    expect(() => parseTrackJudgementResponse('{"totalScore": 7')).toThrow('unterminated');
  });
});

describe('deterministic uncertainty rules', () => {
  const generous = { scenarioFit: 3, mood: 2, lyrics: 2, genre: 2, wildcard: 1 };

  it('trusts every category only when the model knows the song', () => {
    expect(applyKnowledgeRules(generous, 'known', false)).toEqual({
      categories: generous,
      confidence: 'high',
    });
  });

  it('pins lyrics to neutral when only the artist is known', () => {
    expect(applyKnowledgeRules(generous, 'artist_only', false)).toEqual({
      categories: { ...generous, lyrics: 1 },
      confidence: 'medium',
    });
  });

  it('pins every unknowable category to neutral for an unknown song', () => {
    expect(applyKnowledgeRules(generous, 'unknown', false)).toEqual({
      categories: { scenarioFit: 3, mood: 1, lyrics: 1, genre: 1, wildcard: 1 },
      confidence: 'low',
    });
  });

  it('lets a catalog description inform sound but never lyrics', () => {
    expect(applyKnowledgeRules(generous, 'unknown', true)).toEqual({
      categories: { ...generous, lyrics: 1 },
      confidence: 'medium',
    });
  });

  it('also lifts a pessimistic guess back to neutral instead of punishing obscurity', () => {
    const harsh = { scenarioFit: 1, mood: 0, lyrics: 0, genre: 0, wildcard: 0 };
    expect(applyKnowledgeRules(harsh, 'unknown', false).categories).toEqual({
      scenarioFit: 1,
      mood: 1,
      lyrics: 1,
      genre: 1,
      wildcard: 0,
    });
  });
});
