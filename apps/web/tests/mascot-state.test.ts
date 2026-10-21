import { describe, expect, it } from 'vitest';
import type { Snapshot } from '@aux/shared';
import { mascotTalkKey } from '../src/host/mascot-state.js';

const base = {
  roomCode: 'ABCDE',
  roundIdx: 2,
  phaseEndsAt: null,
  playbackMode: 'catalog',
  players: [],
  submissionsCount: 0,
};

describe('DJ AUX talk timing', () => {
  it('talks once per revealed verdict and per revealed result', () => {
    const judging = {
      ...base,
      state: 'AI_JUDGING',
      judgingStatus: 'revealed',
      judgingIndex: 1,
    } as unknown as Snapshot;
    expect(mascotTalkKey(judging)).toBe('judge:2:1');
    expect(
      mascotTalkKey({ ...judging, judgingStatus: 'analyzing' } as unknown as Snapshot),
    ).toBeNull();
    const results = { ...base, state: 'RESULTS', results: [{}, {}] } as unknown as Snapshot;
    expect(mascotTalkKey(results)).toBe('reveal:2:2');
    expect(
      mascotTalkKey({ ...base, state: 'RESULTS', results: [] } as unknown as Snapshot),
    ).toBeNull();
  });

  it('stays quiet everywhere else', () => {
    expect(mascotTalkKey({ ...base, state: 'LOBBY' } as unknown as Snapshot)).toBeNull();
    expect(mascotTalkKey(null)).toBeNull();
    expect(mascotTalkKey(undefined)).toBeNull();
  });
});
