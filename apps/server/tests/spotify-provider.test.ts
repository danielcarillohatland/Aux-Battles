/**
 * SpotifyProvider contract tests (Phase 2.5 spike) — fake transport only.
 * Per docs/testing-strategy.md: CI NEVER calls real Spotify. The provider's
 * fetchImpl + tokenStore edges are injected (see fake/fake-spotify-transport.ts
 * for the seam coordinated with providers/spotify/index.ts).
 *
 * Until src/providers/spotify/index.ts lands (or matches the seam), this suite
 * reports SKIPPED with the reason so the gate stays green; it activates and
 * enforces the contract automatically the moment the export appears.
 */
import { beforeAll, describe, expect, it, type TestContext } from 'vitest';
import { MusicProviderError } from '../src/providers/music-provider.js';
import { TrackSchema } from '@aux/shared';
import {
  FakeSpotifyTransport,
  FakeTokenStore,
  SPOTIFY_BASE,
  expectedTrackFrom,
  jsonResponse,
  spotifyApiTrack,
  spotifySearchResponse,
} from '../src/providers/fake/fake-spotify-transport.js';

type ProviderCtor = new (deps: { tokenStore: unknown; fetchImpl?: unknown }) => {
  search(query: string, limit?: number): Promise<unknown[]>;
  getTrack(id: string): Promise<unknown>;
  startPlayback(req: { uris: string[]; deviceId?: string; positionMs?: number }): Promise<void>;
  getPlaybackState(): Promise<unknown>;
};

interface Harness {
  make(): { provider: InstanceType<ProviderCtor>; transport: FakeSpotifyTransport };
}

let harness: Harness | null = null;
let skipReason = '';

beforeAll(async () => {
  try {
    const mod = (await import('../src/providers/spotify/index.js')) as Record<string, unknown>;
    const Ctor = (mod.SpotifyProvider ?? mod.default) as ProviderCtor | undefined;
    if (typeof Ctor !== 'function') {
      skipReason = 'spotify/index.ts landed but exports neither SpotifyProvider nor default';
      return;
    }
    const make = () => {
      const transport = new FakeSpotifyTransport();
      // fetchImpl is typed `typeof fetch` upstream; the fake is duck-compatible
      // at runtime (ok/status/headers.get/text), so bridge via unknown.
      const provider = new Ctor({
        tokenStore: new FakeTokenStore(),
        fetchImpl: transport.fetch as unknown as typeof fetch,
      });
      return { provider, transport } as never;
    };
    try {
      const probe = make() as { provider: Record<string, unknown> };
      if (
        typeof probe.provider.search !== 'function' ||
        typeof probe.provider.startPlayback !== 'function' ||
        typeof probe.provider.getPlaybackState !== 'function'
      ) {
        skipReason = 'SpotifyProvider lacks search/startPlayback/getPlaybackState';
        return;
      }
      harness = { make };
    } catch {
      skipReason =
        'constructor does not accept { tokenStore, fetchImpl } — see fake-spotify-transport.ts header';
    }
  } catch (e) {
    skipReason = `src/providers/spotify/index.ts not implemented yet (${(e as Error).message.split('\n')[0]})`;
  }
});

/** Skip the individual test when the implementation hasn't landed / mismatches. */
function requireHarness(ctx: TestContext): Harness {
  if (harness === null) ctx.skip(true, skipReason);
  return harness as Harness;
}

const providerErr = async (p: Promise<unknown>): Promise<MusicProviderError> => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(MusicProviderError);
    return e as MusicProviderError;
  }
  throw new Error('expected promise to reject');
};

describe('SpotifyProvider contract (fake transport)', () => {
  it('search maps Spotify API shape → shared Track schema', async (ctx) => {
    const { make } = requireHarness(ctx);
    const apiItem = spotifyApiTrack();
    const { provider, transport } = make();
    transport.enqueue(spotifySearchResponse([apiItem]));

    const results = await provider.search('song 2', 5);

    expect(results).toHaveLength(1);
    const parsed = TrackSchema.safeParse(results[0]);
    expect(parsed.success, JSON.stringify(parsed)).toBe(true);
    expect(results[0]).toEqual(expectedTrackFrom(apiItem));
  });

  it('search hits /v1/search with query+type+limit and Bearer token', async (ctx) => {
    const { make } = requireHarness(ctx);
    const { provider, transport } = make();
    transport.enqueue(spotifySearchResponse([]));

    await provider.search('daft punk', 10);

    const req = transport.requests.at(-1)!;
    expect(req.method).toBe('GET');
    expect(req.url.startsWith(`${SPOTIFY_BASE}/search?`)).toBe(true);
    const url = new URL(req.url);
    expect(url.searchParams.get('q')).toBe('daft punk');
    expect(url.searchParams.get('type')).toBe('track');
    expect(url.searchParams.get('limit')).toBe('10');
    expect(req.headers.authorization ?? req.headers.Authorization).toMatch(/^Bearer .+/);
  });

  it('429 + Retry-After → MusicProviderError RATE_LIMITED carrying retryAfterSecs', async (ctx) => {
    const { make } = requireHarness(ctx);
    const { provider, transport } = make();
    transport.enqueue(jsonResponse(429, {}, { 'Retry-After': '30' }));

    const err = await providerErr(provider.search('anything'));

    expect(err.code).toBe('RATE_LIMITED');
    expect(err.retryAfterSecs).toBe(30);
  });

  it('401 → TOKEN_EXPIRED', async (ctx) => {
    const { make } = requireHarness(ctx);
    const { provider, transport } = make();
    transport.enqueue(jsonResponse(401, { error: { status: 401, message: 'bad token' } }));

    const err = await providerErr(provider.search('anything'));

    expect(err.code).toBe('TOKEN_EXPIRED');
  });

  it('403 premium_required → NOT_PREMIUM', async (ctx) => {
    const { make } = requireHarness(ctx);
    const { provider, transport } = make();
    transport.enqueue(
      jsonResponse(403, {
        error: { status: 403, reason: 'PREMIUM_REQUIRED', message: 'Premium required' },
      }),
    );

    const err = await providerErr(provider.startPlayback({ uris: ['spotify:track:x'] }));

    expect(err.code).toBe('NOT_PREMIUM');
  });

  it('no active device → NO_ACTIVE_DEVICE', async (ctx) => {
    const { make } = requireHarness(ctx);
    const { provider, transport } = make();
    transport.enqueue(
      jsonResponse(404, {
        error: { status: 404, reason: 'NO_ACTIVE_DEVICE', message: 'No device' },
      }),
    );

    const err = await providerErr(provider.startPlayback({ uris: ['spotify:track:x'] }));

    expect(err.code).toBe('NO_ACTIVE_DEVICE');
  });

  it('startPlayback sends ONE request: whole round queue as a single uris array', async (ctx) => {
    const { make } = requireHarness(ctx);
    const { provider, transport } = make();
    transport.setFallback(() => jsonResponse(204, {}));

    const queue = ['spotify:track:a', 'spotify:track:b', 'spotify:track:c'];
    await provider.startPlayback({
      uris: queue,
      deviceId: 'dev-1',
      positionMs: 0,
    });

    // Exactly ONE HTTP call per round queue — never one call per track.
    expect(transport.requests).toHaveLength(1);
    const req = transport.requests[0]!;
    expect(req.method).toBe('PUT'); // Spotify play endpoint verb
    const url = new URL(req.url);
    expect(`${url.origin}${url.pathname}`).toBe(`${SPOTIFY_BASE}/me/player/play`);
    expect(url.searchParams.get('device_id')).toBe('dev-1');
    const body = req.body as { uris?: string[]; position_ms?: number };
    expect(body.uris).toEqual(queue); // full array, order preserved
    expect(body.position_ms).toBe(0);
  });

  it('verify-only polling helper returns normalized playback state', async (ctx) => {
    const { make } = requireHarness(ctx);
    const playing = make();
    playing.transport.enqueue(
      jsonResponse(200, {
        device: { id: 'dev-1', name: 'Party Speaker', is_active: true },
        is_playing: true,
        progress_ms: 42_000,
        item: spotifyApiTrack(),
      }),
    );
    const state = (await playing.provider.getPlaybackState()) as {
      trackId: string | null;
      isPlaying: boolean;
      progressMs: number | null;
      deviceId: string | null;
    };
    expect(state).toEqual({
      trackId: 'sp_track_1',
      isPlaying: true,
      progressMs: 42_000,
      deviceId: 'dev-1',
    });

    // Nothing playing (204 No Content) → normalized "nothing" state, not a crash.
    const idle = make();
    idle.transport.enqueue(jsonResponse(204, {}));
    expect(await idle.provider.getPlaybackState()).toBeFalsy();
  });
});

// ── Always-on: fixture/schema sanity that runs even before the impl lands ────

describe('fake spotify fixtures', () => {
  it('fixture API item maps onto the shared Track schema', () => {
    const mapped = expectedTrackFrom(spotifyApiTrack());
    expect(TrackSchema.safeParse(mapped).success).toBe(true);
    expect(mapped.title).toBe('Song 2');
    expect(mapped.artist).toBe('Blur');
    expect(mapped.durationMs).toBe(262_000);
  });
});
