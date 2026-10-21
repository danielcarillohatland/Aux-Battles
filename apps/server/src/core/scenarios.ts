/**
 * Round prompt selection (D-029). The catalogue lives in @aux/shared so the
 * host picker and the server draw from the same list. The host either picks a
 * vibe (a theme id), asks for a surprise, or types a custom prompt that is used
 * verbatim.
 */
import { randomInt } from 'node:crypto';
import {
  findScenarioTheme,
  SCENARIO_THEMES,
  SURPRISE_THEME_ID,
  type ScenarioTheme,
} from '@aux/shared';

export { SCENARIO_THEMES, SURPRISE_THEME_ID, findScenarioTheme };
export type { ScenarioTheme };

export const RECENT_SCENARIO_LIMIT = 16;
export const CUSTOM_PROMPT_ID = 'custom';

export interface ScenarioDraw {
  id: string;
  theme: string;
  scenario: string;
  /** The agreed feeling the song should create; null for a custom prompt. */
  vibe: string | null;
  recentIds: string[];
}

/** Draw a non-recent scenario from the given theme (or a random theme). */
export function drawScenario(
  recentIds: readonly string[],
  pickIndex: (upperExclusive: number) => number = randomInt,
  theme: ScenarioTheme = SCENARIO_THEMES[pickIndex(SCENARIO_THEMES.length)]!,
): ScenarioDraw {
  const all = theme.scenarios.map(({ scene, vibe }, index) => ({
    id: `${theme.id}:${index}`,
    scenario: scene,
    vibe,
  }));
  const fresh = all.filter(({ id }) => !recentIds.includes(id));
  const pool = fresh.length > 0 ? fresh : all;
  const chosen = pool[pickIndex(pool.length)]!;
  return {
    ...chosen,
    theme: theme.name,
    recentIds: [...recentIds, chosen.id].slice(-RECENT_SCENARIO_LIMIT),
  };
}

/**
 * Turn the host's pick into the round prompt: a theme id/name draws from that
 * vibe, the surprise sentinel draws from any vibe, anything else is a custom
 * prompt used as written.
 */
export function resolveRoundPrompt(
  pick: string,
  recentIds: readonly string[],
  pickIndex: (upperExclusive: number) => number = randomInt,
): ScenarioDraw {
  const trimmed = pick.trim();
  if (trimmed.toLowerCase() === SURPRISE_THEME_ID) return drawScenario(recentIds, pickIndex);
  const theme = findScenarioTheme(trimmed);
  if (theme !== undefined) return drawScenario(recentIds, pickIndex, theme);
  const scenario = trimmed.replace(/\s+/g, ' ').slice(0, 240);
  return { id: CUSTOM_PROMPT_ID, theme: 'Custom', scenario, vibe: null, recentIds: [...recentIds] };
}
