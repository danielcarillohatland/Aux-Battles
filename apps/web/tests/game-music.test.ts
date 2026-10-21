import { describe, expect, it } from 'vitest';
import { musicSceneForState } from '../src/host/game-music.js';

describe('host background music scenes', () => {
  it('uses a distinct lobby bed and pauses under submitted-song playback', () => {
    expect(musicSceneForState('LOBBY')).toBe('lobby');
    expect(musicSceneForState('CATEGORY')).toBe('gameplay');
    expect(musicSceneForState('SCENARIO')).toBe('gameplay');
    expect(musicSceneForState('SONG_SELECTION')).toBe('gameplay');
    expect(musicSceneForState('PLAYBACK')).toBe('silent');
    expect(musicSceneForState('AI_JUDGING')).toBe('gameplay');
    expect(musicSceneForState('RESULTS')).toBe('gameplay');
    expect(musicSceneForState('GAME_OVER')).toBe('gameplay');
  });
});
