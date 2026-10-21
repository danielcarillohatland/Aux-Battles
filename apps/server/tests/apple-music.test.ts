import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { AppleMusicCatalogProvider } from '../src/providers/apple-music/index.js';
import { appleMusicRoute } from '../src/routes/apple-music.js';

const appleSong = {
  id: '1440833080',
  attributes: {
    name: 'Dreams',
    artistName: 'Fleetwood Mac',
    albumName: 'Rumours',
    durationInMillis: 257800,
    artwork: { url: 'https://is1-ssl.mzstatic.com/image/thumb/example/{w}x{h}.jpg' },
    url: 'https://music.apple.com/no/song/dreams/1440833080',
  },
};

describe('AppleMusicCatalogProvider', () => {
  it('searches canonical song metadata and caches it for playback', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ results: { songs: { data: [appleSong] } } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const catalog = new AppleMusicCatalogProvider(
      'developer-token',
      'no',
      fetchMock as unknown as typeof fetch,
    );

    await expect(catalog.search('dreams fleetwood', 10)).resolves.toMatchObject([
      {
        id: 'apple-music:1440833080',
        title: 'Dreams',
        artist: 'Fleetwood Mac',
        album: 'Rumours',
        durationMs: 257800,
        source: 'apple_music',
        attribution: 'Provided by Apple Music',
        artUrl: 'https://is1-ssl.mzstatic.com/image/thumb/example/512x512.jpg',
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/v1/catalog/no/search?'),
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer developer-token' }),
      }),
    );
    // Playback trusts the canonical stored copy (survives a server restart).
    const stored = {
      id: 'apple-music:1440833080',
      title: 'Dreams',
      artist: 'Fleetwood Mac',
      source: 'apple_music' as const,
    };
    expect(catalog.playableTrack(stored, 'ABCDE')).toMatchObject({
      title: 'Dreams',
      source: 'apple_music',
    });
    expect(catalog.playableTrack({ ...stored, id: 'deezer:1' }, 'ABCDE')).toBeNull();
    await expect(catalog.getTrack('apple-music:1440833080')).resolves.toMatchObject({
      artist: 'Fleetwood Mac',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects non-Apple ids without calling the service', async () => {
    const fetchMock = vi.fn();
    const catalog = new AppleMusicCatalogProvider(
      'developer-token',
      'us',
      fetchMock as unknown as typeof fetch,
    );
    await expect(catalog.getTrack('external:123')).rejects.toMatchObject({
      code: 'TRACK_UNPLAYABLE',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('Apple Music host configuration route', () => {
  it('is host-only and returns a no-store MusicKit configuration', async () => {
    const app = Fastify();
    const catalog = new AppleMusicCatalogProvider('developer-token', 'no');
    await app.register(
      appleMusicRoute({
        catalog,
        authorizeHost: (code, token) => code === 'ABCDE' && token === 'host-token',
      }),
    );
    const denied = await app.inject({ method: 'GET', url: '/rooms/ABCDE/apple-music/config' });
    expect(denied.statusCode).toBe(403);

    const allowed = await app.inject({
      method: 'GET',
      url: '/rooms/ABCDE/apple-music/config',
      headers: { authorization: 'Bearer host-token' },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.headers['cache-control']).toContain('no-store');
    expect(allowed.json()).toMatchObject({
      ok: true,
      data: {
        available: true,
        developerToken: 'developer-token',
        storefront: 'no',
      },
    });
    await app.close();
  });
});
