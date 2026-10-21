import { describe, expect, it } from 'vitest';
import { AUX_ORIGINAL_TRACKS, TrackSchema, auxOriginalById } from '../src/index.js';

describe('AUX original catalog', () => {
  it('contains unique, schema-valid, sample-free tracks', () => {
    expect(AUX_ORIGINAL_TRACKS.length).toBeGreaterThanOrEqual(8);
    expect(new Set(AUX_ORIGINAL_TRACKS.map((track) => track.id)).size).toBe(
      AUX_ORIGINAL_TRACKS.length,
    );
    for (const track of AUX_ORIGINAL_TRACKS) {
      expect(TrackSchema.safeParse(track).success).toBe(true);
      expect(track.source).toBe('original');
      expect(track.attribution).toContain('no samples used');
      expect(track.synth.lead).toHaveLength(16);
      expect(track.synth.bass).toHaveLength(16);
    }
  });

  it('includes Midnight Pancakes as a judgeable catalog song', () => {
    expect(auxOriginalById('original:midnight-pancakes')).toMatchObject({
      title: 'Midnight Pancakes',
      artist: 'AUX House Band',
      source: 'original',
    });
  });
});
