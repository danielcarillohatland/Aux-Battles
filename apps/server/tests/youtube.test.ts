import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import {
  YouTubeCatalogProvider,
  parseIsoDurationMs,
  playableInRegion,
  scoreVideoForSong,
  splitVideoTitle,
  youtubeVideoIdOf,
} from '../src/providers/youtube/index.js';
import type { SongIndex } from '../src/providers/song-index/itunes.js';
import { youtubeRoute } from '../src/routes/youtube.js';

const searchPayload = {
  items: [
    { id: { kind: 'youtube#video', videoId: 'FGBhQbmPwH8' } },
    { id: { kind: 'youtube#video', videoId: 'shortclip11' } },
    { id: { kind: 'youtube#video', videoId: 'privatevid1' } },
  ],
};

const videosPayload = {
  items: [
    {
      id: 'FGBhQbmPwH8',
      snippet: {
        title: 'Daft Punk - One More Time (Official Video)',
        channelTitle: 'DaftPunkVEVO',
        liveBroadcastContent: 'none',
        thumbnails: {
          medium: { url: 'https://i.ytimg.com/vi/FGBhQbmPwH8/mqdefault.jpg' },
          high: { url: 'https://i.ytimg.com/vi/FGBhQbmPwH8/hqdefault.jpg' },
        },
      },
      contentDetails: { duration: 'PT5M21S' },
      status: { embeddable: true, privacyStatus: 'public' },
    },
    {
      id: 'shortclip11',
      snippet: { title: 'clip', channelTitle: 'x', liveBroadcastContent: 'none' },
      contentDetails: { duration: 'PT12S' },
      status: { embeddable: true, privacyStatus: 'public' },
    },
    {
      id: 'privatevid1',
      snippet: { title: 'hidden', channelTitle: 'x', liveBroadcastContent: 'none' },
      contentDetails: { duration: 'PT3M' },
      status: { embeddable: false, privacyStatus: 'public' },
    },
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function catalogWith(
  fetchMock: ReturnType<typeof vi.fn>,
  songIndex: SongIndex | null = null,
): YouTubeCatalogProvider {
  return new YouTubeCatalogProvider({
    apiKey: 'test-key',
    regionCode: 'no',
    songIndex,
    fetchImpl: fetchMock as unknown as typeof fetch,
  });
}

const oneMoreTime = {
  id: '697195462',
  title: 'One More Time',
  artist: 'Daft Punk',
  album: 'Discovery',
  durationMs: 320_357,
  artUrl: 'https://is1-ssl.mzstatic.com/image/thumb/x/600x600bb.jpg',
  storeUrl: 'https://music.apple.com/us/album/one-more-time/697194953?i=697195462',
};

const fakeIndex: SongIndex = {
  search: async () => [oneMoreTime],
  lookup: async (id) => (id === oneMoreTime.id ? oneMoreTime : null),
};

describe('YouTubeCatalogProvider', () => {
  it('searches music videos, keeps only embeddable full-length ones, and caches by query', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.includes('/search?') ? jsonResponse(searchPayload) : jsonResponse(videosPayload),
    );
    const catalog = catalogWith(fetchMock);

    const tracks = await catalog.search('daft punk one more time', 10);
    expect(tracks).toEqual([
      {
        id: 'youtube:FGBhQbmPwH8',
        title: 'One More Time',
        artist: 'Daft Punk',
        durationMs: 321_000,
        artUrl: 'https://i.ytimg.com/vi/FGBhQbmPwH8/hqdefault.jpg',
        source: 'youtube',
        attribution: 'Video from YouTube · DaftPunkVEVO',
        externalUrl: 'https://www.youtube.com/watch?v=FGBhQbmPwH8',
      },
    ]);
    const searchUrl = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(searchUrl.pathname).toBe('/youtube/v3/search');
    expect(searchUrl.searchParams.get('videoCategoryId')).toBe('10');
    expect(searchUrl.searchParams.get('videoEmbeddable')).toBe('true');
    expect(searchUrl.searchParams.get('regionCode')).toBe('NO');
    expect(searchUrl.searchParams.get('key')).toBe('test-key');
    const videosUrl = new URL(fetchMock.mock.calls[1]![0] as string);
    expect(videosUrl.pathname).toBe('/youtube/v3/videos');
    expect(videosUrl.searchParams.get('id')).toBe('FGBhQbmPwH8,shortclip11,privatevid1');

    // Repeat searches and submission lookups cost no quota.
    await catalog.search('Daft  Punk one more time');
    await expect(catalog.getTrack('youtube:FGBhQbmPwH8')).resolves.toMatchObject({
      artist: 'Daft Punk',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('serves the song gallery from the metadata index and resolves the best video on submit', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.includes('/search?')
        ? jsonResponse({
            items: [{ id: { videoId: 'coverkaraok' } }, { id: { videoId: 'FGBhQbmPwH8' } }],
          })
        : jsonResponse({
            items: [
              {
                id: 'coverkaraok',
                snippet: {
                  title: 'One More Time - Daft Punk (Karaoke Version)',
                  channelTitle: 'Sing King',
                  liveBroadcastContent: 'none',
                },
                contentDetails: { duration: 'PT5M20S' },
                status: { embeddable: true, privacyStatus: 'public' },
              },
              videosPayload.items[0],
            ],
          }),
    );
    const catalog = catalogWith(fetchMock, fakeIndex);

    const gallery = await catalog.search('daft punk');
    expect(gallery).toMatchObject([
      {
        id: 'song:697195462',
        title: 'One More Time',
        artist: 'Daft Punk',
        album: 'Discovery',
        source: 'youtube',
      },
    ]);
    // Even an index that returns promotional artwork cannot inject it into the game.
    expect(gallery[0]).not.toHaveProperty('artUrl');
    expect(fetchMock).not.toHaveBeenCalled();

    const resolved = await catalog.getTrack('song:697195462');
    // Same-song candidates ride along, best first, so the host can fall back.
    expect(resolved.videoCandidates).toEqual(['FGBhQbmPwH8', 'coverkaraok']);
    expect(resolved).toMatchObject({
      id: 'youtube:FGBhQbmPwH8',
      title: 'One More Time',
      artist: 'Daft Punk',
      album: 'Discovery',
      artUrl: 'https://i.ytimg.com/vi/FGBhQbmPwH8/hqdefault.jpg',
      source: 'youtube',
      attribution: 'Video from YouTube · DaftPunkVEVO',
      externalUrl: 'https://www.youtube.com/watch?v=FGBhQbmPwH8',
    });
    const searchUrl = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(searchUrl.searchParams.get('q')).toBe('Daft Punk One More Time official');
    expect(searchUrl.searchParams.get('order')).toBe('viewCount');
    expect(searchUrl.searchParams.get('maxResults')).toBe('10');
    await catalog.getTrack('song:697195462');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(catalog.getTrack('song:1')).rejects.toMatchObject({ code: 'TRACK_UNPLAYABLE' });
  });

  it('prefers official, title-matching, right-length videos over alternate versions', () => {
    const song = { title: 'Blinding Lights', artist: 'The Weeknd', durationMs: 200_000 };
    const official = scoreVideoForSong(
      {
        title: 'The Weeknd - Blinding Lights (Official Video)',
        channelTitle: 'TheWeekndVEVO',
        durationMs: 262_000,
      },
      song,
    );
    const topic = scoreVideoForSong(
      { title: 'Blinding Lights', channelTitle: 'The Weeknd - Topic', durationMs: 200_040 },
      song,
    );
    const cover = scoreVideoForSong(
      {
        title: 'Blinding Lights - The Weeknd (Acoustic Cover)',
        channelTitle: 'Some Guitarist',
        durationMs: 205_000,
      },
      song,
    );
    expect(official).toBeGreaterThan(cover);
    // Topic art tracks often refuse third-party embeds: rank them below real uploads.
    expect(official).toBeGreaterThan(topic);
    // View-count ordering also returns the artist's other hits: reject them hard.
    const otherSong = scoreVideoForSong(
      {
        title: 'The Weeknd - Starboy ft. Daft Punk (Official Video)',
        channelTitle: 'TheWeekndVEVO',
        durationMs: 230_000,
      },
      song,
    );
    expect(otherSong).toBeLessThan(0);
    expect(official).toBeGreaterThan(otherSong + 5);
  });

  it('shares one request between identical concurrent searches', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.includes('/search?') ? jsonResponse(searchPayload) : jsonResponse(videosPayload),
    );
    const catalog = catalogWith(fetchMock);
    await Promise.all([catalog.search('one more time'), catalog.search('one more time')]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('canonicalizes submissions by video id and rejects foreign or malformed ids', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(videosPayload));
    const catalog = catalogWith(fetchMock);
    await expect(catalog.getTrack('deezer:1')).rejects.toMatchObject({ code: 'TRACK_UNPLAYABLE' });
    await expect(catalog.getTrack('youtube:../x')).rejects.toMatchObject({
      code: 'TRACK_UNPLAYABLE',
    });
    await expect(catalog.getTrack('youtube:privatevid1')).rejects.toMatchObject({
      code: 'TRACK_UNPLAYABLE',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const stored = {
      id: 'youtube:FGBhQbmPwH8',
      title: 'One More Time',
      artist: 'Daft Punk',
      source: 'youtube' as const,
    };
    expect(catalog.playableTrack(stored, 'A7X2M')).toEqual(stored);
    expect(catalog.playableTrack({ ...stored, id: 'apple-music:1' }, 'A7X2M')).toBeNull();
  });

  it('maps quota exhaustion and outages to CATALOG_DOWN', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              code: 403,
              message: 'The request cannot be completed because you have exceeded your quota.',
              errors: [{ reason: 'quotaExceeded' }],
            },
          },
          403,
        ),
      )
      .mockResolvedValueOnce(new Response('bad gateway', { status: 502 }));
    const catalog = catalogWith(fetchMock);
    await expect(catalog.search('anything')).rejects.toMatchObject({
      code: 'CATALOG_DOWN',
      detail: 'YouTube Data API quota exhausted for today',
    });
    await expect(catalog.search('anything else')).rejects.toMatchObject({ code: 'CATALOG_DOWN' });
  });

  it('parses ISO durations and splits common music-video titles', () => {
    expect(parseIsoDurationMs('PT3M20S')).toBe(200_000);
    expect(parseIsoDurationMs('PT1H2M')).toBe(3_720_000);
    expect(parseIsoDurationMs('P0D')).toBeUndefined();
    expect(parseIsoDurationMs(42)).toBeUndefined();
    expect(
      splitVideoTitle('The Weeknd - Blinding Lights (Official Video)', 'TheWeekndVEVO'),
    ).toEqual({
      title: 'Blinding Lights',
      artist: 'The Weeknd',
    });
    expect(splitVideoTitle('Espresso', 'Sabrina Carpenter - Topic')).toEqual({
      title: 'Espresso',
      artist: 'Sabrina Carpenter',
    });
    expect(
      splitVideoTitle('Mr. Brightside [Official Music Video] | The Killers', 'TheKillersVEVO'),
    ).toEqual({ title: 'Mr. Brightside', artist: 'TheKillers' });
    expect(youtubeVideoIdOf('youtube:FGBhQbmPwH8')).toBe('FGBhQbmPwH8');
    expect(youtubeVideoIdOf('youtube:nope')).toBeNull();
  });

  it('drops region-restricted videos for the configured region', () => {
    const allowedList = { contentDetails: { regionRestriction: { allowed: ['US', 'GB'] } } };
    const blockedList = { contentDetails: { regionRestriction: { blocked: ['NO'] } } };
    expect(playableInRegion(allowedList, 'NO')).toBe(false);
    expect(playableInRegion(allowedList, 'US')).toBe(true);
    expect(playableInRegion(blockedList, 'NO')).toBe(false);
    expect(playableInRegion(blockedList, 'SE')).toBe(true);
    expect(playableInRegion({}, 'NO')).toBe(true);
    expect(playableInRegion(allowedList, undefined)).toBe(true);
  });

  it('is configured only through the server-side API key', () => {
    expect(YouTubeCatalogProvider.fromEnv({})).toBeNull();
    expect(YouTubeCatalogProvider.fromEnv({ AUX_YOUTUBE_API_KEY: 'k' })).toBeInstanceOf(
      YouTubeCatalogProvider,
    );
    expect(() => new YouTubeCatalogProvider({ apiKey: 'k', regionCode: 'Norway' })).toThrow(
      /two-letter/,
    );
  });
});

describe('YouTube host status route', () => {
  it('is host-only', async () => {
    const app = Fastify();
    await app.register(
      youtubeRoute({
        available: true,
        authorizeHost: (code, token) => code === 'A7X2M' && token === 'host-token',
      }),
    );
    expect(
      (await app.inject({ method: 'GET', url: '/rooms/A7X2M/youtube/status' })).statusCode,
    ).toBe(403);
    const ok = await app.inject({
      method: 'GET',
      url: '/rooms/A7X2M/youtube/status',
      headers: { authorization: 'Bearer host-token' },
    });
    expect(ok.json()).toMatchObject({ ok: true, data: { available: true } });
    await app.close();
  });
});
