/**
 * Fake Spotify transport (Phase 2.5 spike): scriptable `fetchImpl` + token store
 * so SpotifyProvider contract tests NEVER touch the real Spotify API (TDD §7,
 * testing-strategy.md §1 integration rules).
 *
 * ── COORDINATION CONTRACT (matches apps/server/src/providers/spotify/index.ts)
 *
 *   new SpotifyProvider({ tokenStore: SpotifyTokenStore, fetchImpl?: typeof fetch })
 *
 *   SpotifyTokenStore.getAccessToken(): Promise<string | null>   // null = never OAuthed
 *   All HTTP goes through `fetchImpl`; every response is read via
 *   ok/status/headers.get()/text(). Error mapping (providers/spotify/playback.ts):
 *     429 + Retry-After → RATE_LIMITED(retryAfterSecs) · 401 → TOKEN_EXPIRED
 *     403 → NOT_PREMIUM · 404 NO_ACTIVE_DEVICE → NO_ACTIVE_DEVICE · else PROVIDER_DOWN
 */
import type { Track } from '@aux/shared';
import { TrackSchema } from '@aux/shared';

/** Minimal surface of `Response` a provider needs; mirrors real fetch semantics. */
export interface FakeFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type FetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

export type SpotifyFetchLike = (url: string, init?: FetchInit) => Promise<FakeFetchResponse>;

/** Token edge: provider asks here for every request's Bearer token. */
export interface SpotifyTokenStore {
  getAccessToken(): Promise<string | null>;
}

export class FakeTokenStore implements SpotifyTokenStore {
  accessToken: string | null = 'fake-access-token';
  reads = 0;

  async getAccessToken(): Promise<string | null> {
    this.reads += 1;
    return this.accessToken;
  }
}

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** Parsed JSON body when present, else the raw string, else undefined. */
  body?: unknown;
}

/**
 * Scriptable transport: queue canned responses (or set a fallback handler),
 * then inspect everything the provider sent.
 */
export class FakeSpotifyTransport {
  readonly requests: RecordedRequest[] = [];
  private queue: Array<FakeFetchResponse | ((req: RecordedRequest) => FakeFetchResponse)> = [];
  private fallback: ((req: RecordedRequest) => FakeFetchResponse) | null = null;

  /** Queue a canned response (or a per-request responder). */
  enqueue(res: FakeFetchResponse | ((req: RecordedRequest) => FakeFetchResponse)): void {
    this.queue.push(res);
  }

  /** Used when the scripted queue is empty (default: 200 `{}`). */
  setFallback(fn: (req: RecordedRequest) => FakeFetchResponse): void {
    this.fallback = fn;
  }

  readonly fetch: SpotifyFetchLike = async (url, init) => {
    const req: RecordedRequest = {
      url,
      method: init?.method ?? 'GET',
      headers: init?.headers ?? {},
      ...(init?.body !== undefined ? { body: safeJsonParse(init.body) ?? init.body } : {}),
    };
    this.requests.push(req);
    const next = this.queue.shift();
    if (next === undefined) {
      if (this.fallback) return this.fallback(req);
      return jsonResponse(200, {});
    }
    return typeof next === 'function' ? next(req) : next;
  };
}

export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): FakeFetchResponse {
  const lower: Record<string, string> = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    headers: { get: (name) => lower[name.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

// ── Spotify Web API fixture builders (v1 shapes) ─────────────────────────────

export function spotifyApiTrack(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'sp_track_1',
    name: 'Song 2',
    artists: [{ id: 'a1', name: 'Blur' }],
    album: {
      id: 'al1',
      name: 'Blur',
      images: [{ url: 'https://i.scdn.co/image/cover', height: 640, width: 640 }],
    },
    duration_ms: 262_000,
    uri: 'spotify:track:sp_track_1',
    ...overrides,
  };
}

export function spotifySearchResponse(tracks: ReturnType<typeof spotifyApiTrack>[]) {
  return jsonResponse(200, {
    tracks: { items: tracks, total: tracks.length },
  });
}

/** Build the shared-schema Track we EXPECT the provider to map an API item into. */
export function expectedTrackFrom(apiItem: ReturnType<typeof spotifyApiTrack>): Track {
  const mapped = {
    id: apiItem.id,
    title: apiItem.name,
    artist: apiItem.artists[0]?.name ?? '',
    album: apiItem.album?.name,
    durationMs: apiItem.duration_ms,
    artUrl: apiItem.album?.images?.[0]?.url,
  };
  const parsed = TrackSchema.safeParse(mapped);
  if (!parsed.success) throw new Error('fixture does not satisfy TrackSchema');
  return parsed.data;
}

export const SPOTIFY_BASE = 'https://api.spotify.com/v1';
