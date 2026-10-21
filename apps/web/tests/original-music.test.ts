import { describe, expect, it } from 'vitest';
import { originalStepDurationMs } from '../src/host/original-music.js';

describe('AUX original playback recipes', () => {
  it('resolves the new judgeable track to a playable tempo', () => {
    expect(originalStepDurationMs('original:midnight-pancakes')).toBeCloseTo(133.93, 1);
  });

  it('rejects ids outside the project-owned catalog', () => {
    expect(originalStepDurationMs('external:not-allowed')).toBeNull();
  });
});
