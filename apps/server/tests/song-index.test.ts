import { describe, expect, it, vi } from 'vitest';
import { ITunesSongIndex, asSongHit, rankSongHits } from '../src/providers/song-index/itunes.js';
import { ManualSongCatalog } from '../src/providers/song-index/manual-catalog.js';

const itunesSong = {
  wrapperType: 'track',
  kind: 'song',
  trackId: 697195462,
  artistName: 'Daft Punk',
  collectionName: 'Discovery',
  trackName: 'One More Time',
  trackViewUrl: 'https://music.apple.com/us/album/one-more-time/697194953?i=697195462&uo=4',
  previewUrl: 'https://audio-ssl.itunes.apple.com/never-used.m4a',
  artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/Music221/v4/fd/dj.jpg/100x100bb.jpg',
  trackTimeMillis: 320357,
};

function textResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'text/javascript; charset=utf-8' },
  });
}

describe('ITunesSongIndex', () => {
  it('maps store results to metadata without promotional art or preview URLs', async () => {
    const fetchMock = vi.fn(async (_url: string) =>
      textResponse({ resultCount: 1, results: [itunesSong] }),
    );
    const index = new ITunesSongIndex({
      country: 'NO',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const hits = await index.search('daft punk one more time', 20);
    expect(hits).toEqual([
      {
        id: '697195462',
        title: 'One More Time',
        artist: 'Daft Punk',
        album: 'Discovery',
        durationMs: 320357,
        storeUrl: itunesSong.trackViewUrl,
      },
    ]);
    expect(JSON.stringify(hits)).not.toContain('audio-ssl');
    expect(JSON.stringify(hits)).not.toContain('mzstatic');
    const url = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(url.host).toBe('itunes.apple.com');
    expect(url.searchParams.get('entity')).toBe('song');
    expect(url.searchParams.get('country')).toBe('no');

    // Lookups of searched songs hit the cache; unknown ids go to the store once.
    await expect(index.lookup('697195462')).resolves.toMatchObject({ title: 'One More Time' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockResolvedValueOnce(textResponse({ resultCount: 0, results: [] }));
    await expect(index.lookup('42')).resolves.toBeNull();
    await expect(index.lookup('not-an-id')).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('ranks the exact-title original above versions and covers, and de-duplicates', () => {
    const ranked = rankSongHits(
      [
        { id: '1', title: 'Blinding Lights (Country Version)', artist: 'Tebey' },
        { id: '2', title: 'Blinding Lights', artist: 'Teddy Swims' },
        { id: '3', title: 'Blinding Lights (Remix)', artist: 'The Weeknd & ROSALÍA' },
        { id: '4', title: 'Blinding Lights', artist: 'The Weeknd' },
        { id: '5', title: 'Blinding Lights', artist: 'The Weeknd' },
      ],
      'blinding lights',
    );
    // The Weeknd appears twice (two releases) and jumps ahead of the single-release cover.
    expect(ranked.map((hit) => hit.id)).toEqual(['4', '2', '1', '3']);
    // Asking for a remix keeps remixes in play.
    expect(
      rankSongHits(
        [
          { id: '4', title: 'Blinding Lights', artist: 'The Weeknd' },
          { id: '3', title: 'Blinding Lights (Remix)', artist: 'The Weeknd & ROSALÍA' },
        ],
        'blinding lights remix',
      ).map((hit) => hit.id),
    ).toEqual(['3', '4']);
  });

  it('ignores non-song results', () => {
    expect(asSongHit({ ...itunesSong, kind: 'music-video' })).toBeNull();
    expect(asSongHit({ trackId: 1, trackName: 'x' })).toBeNull();
  });
});

describe('ManualSongCatalog', () => {
  it('turns gallery hits into canonical manual picks without any audio', async () => {
    const catalog = new ManualSongCatalog({
      search: async () => [
        {
          id: '1',
          title: 'One More Time',
          artist: 'Daft Punk',
          album: 'Discovery',
          durationMs: 320_357,
          artUrl: 'https://is1-ssl.mzstatic.com/promotional-album-art.jpg',
        },
      ],
      lookup: async () => null,
    });
    await expect(catalog.search('daft')).resolves.toMatchObject([
      { id: 'manual:one%20more%20time:daft%20punk', source: 'manual', title: 'One More Time' },
    ]);
    expect((await catalog.search('daft'))[0]).not.toHaveProperty('artUrl');
    await expect(catalog.getTrack('manual:x:y')).rejects.toMatchObject({
      code: 'TRACK_UNPLAYABLE',
    });
    expect(
      catalog.playableTrack({ id: 'manual:x:y', title: 'x', artist: 'y' }, 'A7X2M'),
    ).toBeNull();
  });
});
