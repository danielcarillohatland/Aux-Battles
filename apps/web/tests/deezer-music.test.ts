import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchDeezerPreview, parseDeezerPreview } from '../src/host/deezer-music.js';

const CLIP = 'https://cdnt-preview.dzcdn.net/api/1/1/a/b/c/d/clip.mp3?hdnea=exp=1788629802~hmac=x';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Deezer preview envelope parsing', () => {
  it('accepts a fresh https clip and fills defaults', () => {
    expect(
      parseDeezerPreview({ ok: true, data: { previewUrl: CLIP, expiresAt: 1, previewMs: 30_000 } }),
    ).toEqual({ previewUrl: CLIP, expiresAt: 1, previewMs: 30_000 });
    expect(parseDeezerPreview({ ok: true, data: { previewUrl: CLIP } })).toEqual({
      previewUrl: CLIP,
      expiresAt: null,
      previewMs: 30_000,
    });
  });

  it('rejects error envelopes and non-https urls with readable messages', () => {
    expect(() =>
      parseDeezerPreview({ ok: false, error: { code: 'INVALID_ACTION', message: 'gone' } }),
    ).toThrow('gone');
    expect(() =>
      parseDeezerPreview({ ok: true, data: { previewUrl: 'http://x/clip.mp3' } }),
    ).toThrow(/no playable preview/);
    expect(() => parseDeezerPreview(null)).toThrow(/unavailable/);
  });
});

describe('fetchDeezerPreview', () => {
  it('sends the host token to the room-bound endpoint with no-store caching', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, data: { previewUrl: CLIP, expiresAt: null } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      fetchDeezerPreview('/api/v1/rooms/A7X2M/deezer/deezer%3A1/preview', 'host-token'),
    ).resolves.toMatchObject({ previewUrl: CLIP });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/rooms/A7X2M/deezer/deezer%3A1/preview',
      expect.objectContaining({
        cache: 'no-store',
        headers: expect.objectContaining({ authorization: 'Bearer host-token' }),
      }),
    );
  });

  it('surfaces server error messages and network failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ ok: false, error: { code: 'INTERNAL', message: 'Deezer is down' } }),
            { status: 503 },
          ),
      ),
    );
    await expect(fetchDeezerPreview('/api/v1/x', 't')).rejects.toThrow('Deezer is down');

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    await expect(fetchDeezerPreview('/api/v1/x', 't')).rejects.toThrow(/Could not reach/);
  });
});
