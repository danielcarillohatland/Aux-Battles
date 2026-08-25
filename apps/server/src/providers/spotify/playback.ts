/**
 * Spotify Web API transport for SpotifyProvider (TDD §7, L0 API autoplay).
 *
 * This module owns ALL HTTP specifics of the Spotify Web API:
 *  - endpoint calls (search, tracks, player control, devices, playback state)
 *  - error/status mapping onto the shared ProviderError taxonomy
 *  - 429 handling honoring Retry-After (circuit-breaker input)
 *  - Spotify payload → shared Track schema mapping (@aux/shared)
 *
 * No live calls at import time: every request goes through an injected
 * `fetchImpl` (defaults to globalThis.fetch) and only fires from methods,
 * so importing this module is side-effect free.
 */
import type { Track } from '@aux/shared';
import { MusicProviderError } from '../music-provider.js';

/** Minimal token dependency — S1 builds the real store; tests stub this. */
export interface SpotifyTokenStore {
  /** Valid, non-expired access token, or null if the host never OAuthed. */
  getAccessToken(): Promise<string | null>;
}

export interface SpotifyApiOptions {
  tokenStore: SpotifyTokenStore;
  /** Injectable fetch for tests; defaults to the global one. */
  fetchImpl?: typeof fetch;
  apiBase?: string;
}

const DEFAULT_API_BASE = 'https://api.spotify.com/v1';
/** TDD §7: search `limit≤10`. */
export const SEARCH_LIMIT_MAX = 10;

// ── Raw Spotify payload shapes (only the fields we consume) ─────────────────

interface SpotifyImage {
  url: string;
}

interface SpotifyTrack {
  id: string | null;
  name: string;
  duration_ms: number;
  explicit?: boolean;
  is_playable?: boolean;
  artists?: Array<{ name: string }>;
  album?: { name?: string; images?: SpotifyImage[] };
}

interface SpotifyDevice {
  id: string | null;
  name: string;
  is_active?: boolean;
}

/** Verify-only polling shape (TDD §7 "verify-don't-drive", 5–10 s cadence). */
export interface PlaybackState {
  isPlaying: boolean;
  progressMs: number | null;
  trackId: string | null;
  deviceId: string | null;
}

// ── Error mapping ────────────────────────────────────────────────────────────

function mapStatusError(status: number, retryAfterSecs: number | null): MusicProviderError {
  switch (status) {
    case 401:
      return new MusicProviderError('TOKEN_EXPIRED');
    case 403:
      // Spotify returns 403 PREMIUM_REQUIRED (and censored-track 403s).
      return new MusicProviderError('NOT_PREMIUM');
    case 404:
      // Player endpoints 404 when no device holds a session.
      return new MusicProviderError('NO_ACTIVE_DEVICE');
    case 429:
      // Retry-After honored per TDD §7 circuit breaker.
      return new MusicProviderError('RATE_LIMITED', retryAfterSecs ?? 1);
    default:
      if (status >= 400 && status < 500) {
        // Unexpected client error — treat as provider fault, not caller bug.
        return new MusicProviderError('PROVIDER_DOWN');
      }
      return new MusicProviderError('PROVIDER_DOWN');
  }
}

function parseRetryAfter(res: Response): number | null {
  const raw = res.headers.get('Retry-After');
  if (raw === null) return null;
  const secs = Number.parseInt(raw, 10);
  return Number.isFinite(secs) ? secs : null;
}

// ── Mapping to the shared Track schema ───────────────────────────────────────

function clamp(s: string, max = 80): string {
  return s.length > max ? s.slice(0, max) : s;
}

export function mapSpotifyTrack(t: SpotifyTrack): Track | null {
  // Local files / unplayable-in-market entries come back with id === null or
  // is_playable === false — they can never be queued, so drop them here.
  if (!t.id) return null;
  if (t.is_playable === false) return null;
  if (t.duration_ms <= 0 || t.name.trim().length === 0) return null;
  const artist = t.artists?.[0]?.name ?? '';
  if (artist.trim().length === 0) return null;
  const track: Track = {
    id: t.id,
    title: clamp(t.name),
    artist: clamp(artist),
  };
  const albumName = t.album?.name;
  if (albumName && albumName.trim().length > 0) track.album = clamp(albumName);
  if (t.duration_ms > 0) track.durationMs = t.duration_ms;
  const artUrl = t.album?.images?.[0]?.url;
  if (artUrl) track.artUrl = artUrl;
  return track;
}

// ── Transport ────────────────────────────────────────────────────────────────

export class SpotifyApiClient {
  private readonly tokenStore: SpotifyTokenStore;
  private readonly fetchImpl: typeof fetch;
  private readonly apiBase: string;

  constructor(options: SpotifyApiOptions) {
    this.tokenStore = options.tokenStore;
    this.apiBase = options.apiBase ?? DEFAULT_API_BASE;
    // Bind lazily so test-provided stubs don't lose their receiver.
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  /**
   * Single request funnel. Throws MusicProviderError with the mapped code on
   * any failure; returns parsed JSON on success. Network failures map to
   * PROVIDER_DOWN (AbortError/timeouts included).
   */
  async request<T>(
    method: 'GET' | 'PUT' | 'POST',
    path: string,
    opts: { body?: Record<string, unknown>; query?: Record<string, string> } = {},
  ): Promise<T> {
    const token = await this.tokenStore.getAccessToken();
    if (!token) throw new MusicProviderError('TOKEN_EXPIRED');

    const url = new URL(`${this.apiBase}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);

    let res: Response;
    try {
      res = await this.fetchImpl(url.toString(), {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      });
    } catch {
      throw new MusicProviderError('PROVIDER_DOWN');
    }

    if (!res.ok) throw mapStatusError(res.status, parseRetryAfter(res));

    // 204 No Content (pause/next/empty state polls) has nothing to parse.
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (text.length === 0) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new MusicProviderError('PROVIDER_DOWN');
    }
  }

  async searchTracks(query: string, limit: number): Promise<Track[]> {
    const clampedLimit = Math.max(1, Math.min(limit, SEARCH_LIMIT_MAX));
    const res = await this.request<{ tracks?: { items: SpotifyTrack[] } }>('GET', '/search', {
      query: { q: query, type: 'track', limit: String(clampedLimit) },
    });
    const items = res.tracks?.items ?? [];
    const out: Track[] = [];
    for (const item of items) {
      const mapped = mapSpotifyTrack(item);
      if (mapped) out.push(mapped);
      if (out.length >= clampedLimit) break;
    }
    return out;
  }

  async getTrackById(id: string): Promise<Track> {
    const raw = await this.request<SpotifyTrack>('GET', `/tracks/${encodeURIComponent(id)}`);
    const mapped = mapSpotifyTrack(raw);
    if (!mapped) throw new MusicProviderError('TRACK_UNPLAYABLE');
    return mapped;
  }

  async startPlayback(req: {
    uris: string[];
    deviceId?: string;
    positionMs?: number;
  }): Promise<void> {
    const body: Record<string, unknown> = { uris: req.uris };
    if (req.positionMs !== undefined) body.position_ms = Math.max(0, Math.floor(req.positionMs));
    await this.request<void>('PUT', '/me/player/play', {
      body,
      query: req.deviceId !== undefined ? { device_id: req.deviceId } : {},
    });
  }

  async pausePlayback(): Promise<void> {
    await this.request<void>('PUT', '/me/player/pause');
  }

  async resumePlayback(): Promise<void> {
    await this.request<void>('PUT', '/me/player/play');
  }

  skipToNext(): Promise<void> {
    return this.request<void>('POST', '/me/player/next').then(() => undefined);
  }

  async listDevices(): Promise<Array<{ id: string; name: string; isActive: boolean }>> {
    const res = await this.request<{ devices?: SpotifyDevice[] }>('GET', '/me/player/devices');
    const devices: Array<{ id: string; name: string; isActive: boolean }> = [];
    for (const d of res.devices ?? []) {
      if (!d.id) continue;
      devices.push({ id: d.id, name: d.name, isActive: d.is_active === true });
    }
    return devices;
  }

  /** GET /me/player → null on 204 (no active session). */
  async getCurrentPlayback(): Promise<PlaybackState | null> {
    const res = await this.request<{
      is_playing?: boolean;
      progress_ms?: number;
      item?: SpotifyTrack | null;
      device?: SpotifyDevice | null;
    }>('GET', '/me/player');
    if (res === undefined || res === null) return null;
    return {
      isPlaying: res.is_playing === true,
      progressMs: typeof res.progress_ms === 'number' ? res.progress_ms : null,
      trackId: res.item?.id ?? null,
      deviceId: res.device?.id ?? null,
    };
  }
}
