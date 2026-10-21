import { describe, expect, it } from 'vitest';
import { OriginalCatalogProvider } from '../src/providers/original-catalog/index.js';

describe('AUX Originals catalog', () => {
  it.each([
    ['pancakes', 'Midnight Pancakes'],
    ['victory', 'Confetti Forecast'],
    ['gym', 'Pocket-Sized Thunder'],
    ['heartbreak', 'Soft-Launch Heartbreak'],
    ['chaos', 'Wrong Turn, Right Party'],
  ])('finds an original for %s', async (query, expected) => {
    const tracks = await new OriginalCatalogProvider().search(query);
    expect(tracks.some((track) => track.title === expected)).toBe(true);
    expect(tracks.every((track) => track.source === 'original')).toBe(true);
  });

  it('returns canonical metadata and rejects external ids', async () => {
    const catalog = new OriginalCatalogProvider();
    await expect(catalog.getTrack('original:midnight-pancakes')).resolves.toMatchObject({
      title: 'Midnight Pancakes',
      artist: 'AUX House Band',
      description: expect.stringContaining('funk-pop'),
    });
    await expect(catalog.getTrack('spotify:track:external')).rejects.toMatchObject({
      code: 'TRACK_UNPLAYABLE',
    });
  });
});
