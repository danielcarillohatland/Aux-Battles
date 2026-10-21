import { describe, expect, it } from 'vitest';
import {
  CUSTOM_PROMPT_ID,
  drawScenario,
  RECENT_SCENARIO_LIMIT,
  resolveRoundPrompt,
  SCENARIO_THEMES,
} from '../src/core/scenarios.js';

const all = SCENARIO_THEMES.flatMap((theme) => theme.scenarios.map(({ scene }) => scene));
const vibes = SCENARIO_THEMES.flatMap((theme) => theme.scenarios.map(({ vibe }) => vibe));

describe('round prompt catalogue (D-029)', () => {
  it('has eight distinct vibes with at least ten unique scenes each', () => {
    expect(SCENARIO_THEMES.map((theme) => theme.id)).toEqual([
      'hype',
      'feel-good',
      'sad-hours',
      'awkward',
      'comedy',
      'cinematic',
      'villain',
      'throwback',
    ]);
    expect(SCENARIO_THEMES.every((theme) => theme.scenarios.length >= 10)).toBe(true);
    expect(new Set(all).size).toBe(all.length);
    expect(
      SCENARIO_THEMES.every((theme) => theme.tagline.length > 0 && theme.emoji.length > 0),
    ).toBe(true);
  });

  it('keeps every scene short, direct, and free of "pick a song" boilerplate', () => {
    const boilerplate =
      /choose (?:a |the |your )?song|pick (?:a |the |your )?song|perfect song|best song|soundtrack (?:the|this)|you have one song|what(?:'s| is) the .*song/i;
    for (const scenario of all) {
      const words = scenario.trim().split(/\s+/).length;
      expect(words, scenario).toBeGreaterThanOrEqual(4);
      expect(words, scenario).toBeLessThanOrEqual(14);
      expect(scenario).not.toMatch(boilerplate);
      expect(scenario.split(/[.!?]+/).filter((part) => part.trim() !== '').length, scenario).toBe(
        1,
      );
    }
  });

  it('gives every scene one short, explicit feeling for players and the judge', () => {
    expect(vibes).toHaveLength(all.length);
    for (const vibe of vibes) {
      const words = vibe.trim().split(/\s+/).length;
      expect(words, vibe).toBeGreaterThanOrEqual(3);
      expect(words, vibe).toBeLessThanOrEqual(10);
      expect(vibe.length, vibe).toBeLessThanOrEqual(120);
    }
  });

  it('draws from the chosen vibe and avoids recently used scenes', () => {
    const first = resolveRoundPrompt('hype', [], () => 0);
    const second = resolveRoundPrompt('Hype', first.recentIds, () => 0);
    expect(first.theme).toBe('Hype');
    expect(second.theme).toBe('Hype');
    expect(first.scenario).toBe('Training montage for a one-year-old football prodigy.');
    expect(first.vibe).toBe('Ridiculously epic, like this baby is the next Messi.');
    expect(second.id).not.toBe(first.id);
    expect(first.scenario).not.toContain('Pick:');
  });

  it('surprise draws any vibe; custom text becomes the prompt verbatim', () => {
    expect(resolveRoundPrompt('surprise', [], () => 2).theme).toBe(SCENARIO_THEMES[2]!.name);
    const custom = resolveRoundPrompt("  songs for grandma's   80th birthday ", ['hype:0']);
    expect(custom).toMatchObject({
      id: CUSTOM_PROMPT_ID,
      theme: 'Custom',
      scenario: "songs for grandma's 80th birthday",
      recentIds: ['hype:0'],
    });
  });

  it('bounds durable recent history', () => {
    let recent: string[] = [];
    for (let index = 0; index < 40; index += 1) {
      recent = drawScenario(recent, (upper) => index % upper).recentIds;
    }
    expect(recent).toHaveLength(RECENT_SCENARIO_LIMIT);
  });
});
