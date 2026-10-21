import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { Track } from '@aux/shared';
import {
  DeezerCatalogProvider,
  deezerPreviewsEnabled,
  previewExpiry,
} from '../src/providers/deezer/index.js';
import { CombinedMusicCatalog, MusicCatalogError } from '../src/providers/music-provider.js';
import { deezerRoute } from '../src/routes/deezer.js';

const PREVIEW_URL =
  'https://cdnt-preview.dzcdn.net/api/1/1/f/8/c/0/f8c5dc3837912dba37c9a1ab3170cc3f.mp3?hdnea=exp=1788629802~acl=/api/1/1/f/8/c/0/f8c5dc3837912dba37c9a1ab3170cc3f.mp3*~data=user_id=0,application_id=42~hmac=abc';

const deezerSong = {
  id: 3135553,
  readable: true,
  title: 'One More Time',
  link: 'https://www.deezer.com/track/3135553',
  duration: 320,
  preview: PREVIEW_URL,
  artist: { id: 27, name: 'Daft Punk' },
  album: {
    id: 302127,
    title: 'Discovery',
    cover_medium: 'https://cdn-images.dzcdn.net/images/cover/x/250x250-000000-80-0-0.jpg',
    cover_big: 'https://cdn-images.dzcdn.net/images/cover/x/500x500-000000-80-0-0.jpg',
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('DeezerCatalogProvider', () => {
  it('searches public metadata without a developer key and canonicalizes submissions', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.includes('/search?')
        ? jsonResponse({ data: [deezerSong, { id: 9, title: 'No clip', artist: { name: 'X' } }] })
        : jsonResponse(deezerSong),
    );
    const catalog = new DeezerCatalogProvider(fetchMock as unknown as typeof fetch);

    const results = await catalog.search('daft punk one more time', 10);
    expect(results).toMatchObject([
      {
        id: 'deezer:3135553',
        title: 'One More Time',
        artist: 'Daft Punk',
        album: 'Discovery',
        durationMs: 320_000,
        source: 'deezer',
        attribution: '30-second preview via Deezer',
        artUrl: 'https://cdn-images.dzcdn.net/images/cover/x/500x500-000000-80-0-0.jpg',
        externalUrl: 'https://www.deezer.com/track/3135553',
      },
    ]);
    // Never leak a short-lived CDN URL to players.
    expect(results[0]).not.toHaveProperty('playbackUrl');
    expect(JSON.stringify(results)).not.toContain('cdnt-preview');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('https://api.deezer.com/search?q=daft%20punk%20one%20more%20time'),
      expect.objectContaining({ headers: expect.objectContaining({ accept: 'application/json' }) }),
    );

    // Submission resolution hits the cache; repeated identical searches do too.
    await expect(catalog.getTrack('deezer:3135553')).resolves.toMatchObject({
      title: 'One More Time',
    });
    await catalog.search('Daft Punk One More Time', 10);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('issues a room-bound preview endpoint and reports the clip length for excerpt planning', () => {
    const catalog = new DeezerCatalogProvider(vi.fn() as unknown as typeof fetch);
    const stored: Track = {
      id: 'deezer:3135553',
      title: 'One More Time',
      artist: 'Daft Punk',
      durationMs: 320_000,
      source: 'deezer',
    };
    expect(catalog.playableTrack(stored, 'A7X2M')).toMatchObject({
      id: 'deezer:3135553',
      durationMs: 320_000,
      playableMs: 30_000,
      playbackUrl: '/api/v1/rooms/A7X2M/deezer/deezer%3A3135553/preview',
    });
    expect(catalog.playableTrack({ ...stored, id: 'apple-music:1' }, 'A7X2M')).toBeNull();
    expect(catalog.playableTrack({ ...stored, id: 'deezer:../x' }, 'A7X2M')).toBeNull();
  });

  it('rejects unknown ids and tracks without a playable clip', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.endsWith('/track/404')
        ? jsonResponse({ error: { type: 'DataException', message: 'no data', code: 800 } })
        : jsonResponse({ ...deezerSong, id: 77, preview: '' }),
    );
    const catalog = new DeezerCatalogProvider(fetchMock as unknown as typeof fetch);
    await expect(catalog.getTrack('external:1')).rejects.toMatchObject({
      code: 'TRACK_UNPLAYABLE',
    });
    await expect(catalog.getTrack('deezer:404')).rejects.toMatchObject({
      code: 'TRACK_UNPLAYABLE',
    });
    await expect(catalog.getTrack('deezer:77')).rejects.toMatchObject({ code: 'TRACK_UNPLAYABLE' });
    await expect(catalog.preview('deezer:77')).rejects.toMatchObject({ code: 'TRACK_UNPLAYABLE' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('turns outages into CATALOG_DOWN and re-fetches previews so signatures stay fresh', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'Quota limit exceeded', code: 4 } }))
      .mockResolvedValueOnce(new Response('down', { status: 502 }))
      // A fresh Response per call: bodies can only be consumed once.
      .mockImplementation(async () => jsonResponse(deezerSong));
    const catalog = new DeezerCatalogProvider(fetchMock as unknown as typeof fetch);
    await expect(catalog.search('anything')).rejects.toMatchObject({ code: 'CATALOG_DOWN' });
    await expect(catalog.search('anything')).rejects.toMatchObject({ code: 'CATALOG_DOWN' });

    const first = await catalog.preview('deezer:3135553');
    const second = await catalog.preview('deezer:3135553');
    expect(first).toEqual({ url: PREVIEW_URL, expiresAt: 1_788_629_802_000, previewMs: 30_000 });
    expect(second.url).toBe(PREVIEW_URL);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('parses signature expiry and tolerates unsigned urls', () => {
    expect(previewExpiry(PREVIEW_URL)).toBe(1_788_629_802_000);
    expect(previewExpiry('https://example.com/clip.mp3')).toBeNull();
  });

  it('is an explicit opt-in everywhere', () => {
    expect(deezerPreviewsEnabled({})).toBe(false);
    expect(deezerPreviewsEnabled({ NODE_ENV: 'development' })).toBe(false);
    expect(deezerPreviewsEnabled({ AUX_DEEZER_PREVIEWS: '1' })).toBe(true);
    expect(deezerPreviewsEnabled({ NODE_ENV: 'production', AUX_DEEZER_PREVIEWS: 'on' })).toBe(true);
    expect(deezerPreviewsEnabled({ AUX_DEEZER_PREVIEWS: '0' })).toBe(false);
    expect(DeezerCatalogProvider.fromEnv({})).toBeNull();
  });
});

describe('CombinedMusicCatalog with a remote catalog', () => {
  it('keeps results from healthy catalogs when one remote search fails', async () => {
    const healthy = {
      search: async () => [{ id: 'licensed:a', title: 'A', artist: 'B' } as Track],
      getTrack: async () => {
        throw new MusicCatalogError('TRACK_UNPLAYABLE');
      },
      listTracks: () => [],
      playableTrack: () => null,
    };
    const broken = {
      ...healthy,
      search: async () => {
        throw new MusicCatalogError('CATALOG_DOWN', 'offline');
      },
    };
    await expect(new CombinedMusicCatalog([broken, healthy]).search('a')).resolves.toMatchObject([
      { id: 'licensed:a' },
    ]);
    await expect(new CombinedMusicCatalog([broken]).search('a')).rejects.toMatchObject({
      code: 'CATALOG_DOWN',
    });
  });
});

describe('Deezer host routes', () => {
  it('are host-only and hand the host a fresh no-store preview url', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(deezerSong));
    const app = Fastify();
    await app.register(
      deezerRoute({
        catalog: new DeezerCatalogProvider(fetchMock as unknown as typeof fetch),
        authorizeHost: (code, token) => code === 'A7X2M' && token === 'host-token',
      }),
    );

    const denied = await app.inject({
      method: 'GET',
      url: '/rooms/A7X2M/deezer/deezer%3A3135553/preview',
    });
    expect(denied.statusCode).toBe(403);

    const status = await app.inject({
      method: 'GET',
      url: '/rooms/A7X2M/deezer/status',
      headers: { authorization: 'Bearer host-token' },
    });
    expect(status.json()).toMatchObject({ ok: true, data: { available: true, previewMs: 30_000 } });

    const preview = await app.inject({
      method: 'GET',
      url: '/rooms/A7X2M/deezer/deezer%3A3135553/preview',
      headers: { authorization: 'Bearer host-token' },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.headers['cache-control']).toContain('no-store');
    expect(preview.json()).toMatchObject({
      ok: true,
      data: { previewUrl: PREVIEW_URL, expiresAt: 1_788_629_802_000, previewMs: 30_000 },
    });

    const missing = await app.inject({
      method: 'GET',
      url: '/rooms/A7X2M/deezer/apple-music%3A1/preview',
      headers: { authorization: 'Bearer host-token' },
    });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });
});
