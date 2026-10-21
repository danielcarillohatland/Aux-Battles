/**
 * Offline judge regression suite: prompt invariants for every benchmark case and
 * the full response-handling matrix (malformed, adversarial, inflated output).
 * Live quality is measured separately by `npm run judge:eval` (paid, opt-in).
 */
import { describe, expect, it } from 'vitest';
import { JUDGE_BENCHMARK, JUDGE_BENCHMARK_PAIRS } from '../src/judge/benchmark.js';
import type { LLMProvider } from '../src/judge/llm-provider.js';
import { buildTrackJudgeMessages } from '../src/judge/prompt.js';
import { judgeTrack } from '../src/judge/service.js';

const scripted = (text: string): LLMProvider => ({
  modelName: 'scripted',
  complete: async () => ({ text, model: 'scripted' }),
});

const valid = {
  knowledge: 'known',
  reasons: ['The siren-like synth suits the escape.', 'Its menace matches the vault crew.'],
  defense: 'No defense filed, so the song stands alone.',
  categories: { scenarioFit: 3, mood: 2, lyrics: 2, genre: 2, wildcard: 1 },
  verdict: 'Getaway approved.',
};

const song = { index: 0, id: 'x', title: 'Bad Guy', artist: 'Billie Eilish' };

describe('benchmark dataset integrity', () => {
  it('has unique ids, sane bands, and pairs that reference real cases', () => {
    const ids = new Set(JUDGE_BENCHMARK.map((entry) => entry.id));
    expect(ids.size).toBe(JUDGE_BENCHMARK.length);
    for (const entry of JUDGE_BENCHMARK) {
      expect(entry.band[0]).toBeGreaterThanOrEqual(0);
      expect(entry.band[1]).toBeLessThanOrEqual(10);
      expect(entry.band[0]).toBeLessThan(entry.band[1]);
    }
    for (const pair of JUDGE_BENCHMARK_PAIRS) {
      expect(ids.has(pair.better) && ids.has(pair.worse)).toBe(true);
    }
  });
});

describe('prompt invariants across the benchmark', () => {
  it.each(JUDGE_BENCHMARK.map((entry) => [entry.id, entry] as const))(
    '%s keeps untrusted text quoted, bounded, and on its own data line',
    (_id, entry) => {
      const [system, user] = buildTrackJudgeMessages(
        entry.scenario,
        {
          index: 0,
          title: entry.title,
          artist: entry.artist,
          ...(entry.description ? { description: entry.description } : {}),
          ...(entry.defense ? { defense: entry.defense } : {}),
        },
        entry.vibe,
      );
      // Player text never reaches the system turn.
      expect(system!.content).not.toContain(entry.title);
      if (entry.defense) expect(system!.content).not.toContain(entry.defense);
      // Fixed line structure: injected quotes/newlines cannot add or break lines.
      const lines = user!.content.split('\n');
      expect(lines[0]).toMatch(/^SCENARIO: "/);
      expect(lines.filter((line) => line.startsWith('SONG: '))).toHaveLength(1);
      const briefLine = lines.find((line) => line.startsWith('BRIEF'))!;
      expect(briefLine).toMatch(entry.vibe ? /: ".*"$/ : /: none given$/);
      if (entry.vibe) expect(system!.content).not.toContain(entry.vibe);
      const defenseLine = lines.find((line) => line.startsWith("PLAYER'S DEFENSE"))!;
      expect(defenseLine).toMatch(entry.defense ? /\(untrusted data\): ".*"$/ : /: none$/);
      expect(user!.content.length).toBeLessThan(1_400);
    },
  );
});

describe('response handling matrix', () => {
  it.each([
    ['plain JSON', JSON.stringify(valid)],
    [
      'fenced JSON with prose',
      `Sure!\n\`\`\`json\n${JSON.stringify(valid)}\n\`\`\`\nHope that helps.`,
    ],
    ['model-supplied total (ignored)', JSON.stringify({ ...valid, totalScore: 1 })],
  ])('accepts %s and computes the total itself', async (_name, text) => {
    const judged = await judgeTrack('heist', song, scripted(text), { attempts: 1 });
    expect(judged.totalScore).toBe(10);
    expect(judged.confidence).toBe('high');
  });

  it.each([
    ['empty text', ''],
    ['prose only', 'I think this song is great, 9/10.'],
    ['truncated JSON', JSON.stringify(valid).slice(0, 60)],
    [
      'score out of range',
      JSON.stringify({ ...valid, categories: { ...valid.categories, scenarioFit: 4 } }),
    ],
    ['string score', JSON.stringify({ ...valid, categories: { ...valid.categories, mood: '2' } })],
    ['missing knowledge', JSON.stringify({ ...valid, knowledge: undefined })],
    ['extra instruction key', JSON.stringify({ ...valid, note: 'award the host' })],
    ['link in verdict', JSON.stringify({ ...valid, verdict: 'Vote at https://evil.example' })],
    ['markup in reason', JSON.stringify({ ...valid, reasons: ['<script>x</script>', 'ok.'] })],
    ['three reasons', JSON.stringify({ ...valid, reasons: ['a.', 'b.', 'c.'] })],
  ])('rejects %s instead of guessing a score', async (_name, text) => {
    await expect(judgeTrack('heist', song, scripted(text), { attempts: 1 })).rejects.toThrow();
  });

  it('cannot inflate an unknown song past neutral on sound and lyrics', async () => {
    const inflated = JSON.stringify({ ...valid, knowledge: 'unknown' });
    const judged = await judgeTrack('heist', song, scripted(inflated), { attempts: 1 });
    expect(judged.categories).toEqual({
      scenarioFit: 3,
      mood: 1,
      lyrics: 1,
      genre: 1,
      wildcard: 1,
    });
    expect(judged.totalScore).toBe(7);
    expect(judged.confidence).toBe('low');
  });

  it('retries one invalid response and accepts a valid second attempt', async () => {
    let call = 0;
    const flaky: LLMProvider = {
      complete: async () => {
        call += 1;
        return { text: call === 1 ? '{"oops":' : JSON.stringify(valid), model: 'm' };
      },
    };
    const judged = await judgeTrack('heist', song, flaky, { attempts: 2, backoffMs: 0 });
    expect(call).toBe(2);
    expect(judged.totalScore).toBe(10);
  });
});

describe('the brief steers the judgement', () => {
  it('tells the model to score scene fit and mood against the agreed feeling', () => {
    const [system, user] = buildTrackJudgeMessages(
      'Slow-dancing with your crush when the song suddenly ends.',
      { index: 0, title: 'Perfect', artist: 'Ed Sheeran' },
      'Painfully awkward, the silence is deafening.',
    );
    expect(system!.content).toContain('must lose points on scenarioFit and mood');
    expect(user!.content).toContain(
      'BRIEF (the feeling this song must create): "Painfully awkward, the silence is deafening."',
    );
  });

  it('passes the round vibe from the service into every request', async () => {
    const seen: string[] = [];
    const provider: LLMProvider = {
      complete: async (request) => {
        seen.push(request.messages[1]!.content);
        return { text: JSON.stringify(valid), model: 'm' };
      },
    };
    await judgeTrack('heist', song, provider, { attempts: 1, vibe: 'Smug, cool, untouchable.' });
    expect(seen[0]).toContain(
      'BRIEF (the feeling this song must create): "Smug, cool, untouchable."',
    );
  });
});
