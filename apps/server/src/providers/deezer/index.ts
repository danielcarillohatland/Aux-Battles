/**
 * Deezer public catalog: song search plus 30-second preview clips.
 *
 * No developer key is needed for the public endpoints used here. Preview URLs
 * are signed by Deezer and expire after roughly 15 minutes, so search and
 * submission only carry metadata; the host resolves a fresh clip URL through a
 * room-bound endpoint when it presses Play (see docs/deezer-music.md, D-023).
 */
import type { Track } from '@aux/shared';
import { MusicCatalogError, type ApprovedMusicCatalog } from '../music-provider.js';
import { TtlCache } from '../../core/ttl-cache.js';

type FetchLike = typeof fetch;

export const DEEZER_API_BASE = 'https://api.deezer.com';
/** Every Deezer preview is a 30-second MP3 excerpt. */
export const DEEZER_PREVIEW_MS = 30_000;
const ID_PREFIX = 'deezer:';
const SEARCH_CACHE_TTL_MS = 2 * 60_000;
const TRACK_CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX_ENTRIES = 500;
/** Deezer's "no data" error code for unknown/removed track ids. */
const DEEZER_DATA_NOT_FOUND = 800;

interface DeezerArtist {
  name?: unknown;
}

interface DeezerAlbum {
  title?: unknown;
  cover?: unknown;
  cover_medium?: unknown;
  cover_big?: unknown;
}

interface DeezerTrackPayload {
  id?: unknown;
  title?: unknown;
  duration?: unknown;
  preview?: unknown;
  readable?: unknown;
  link?: unknown;
  artist?: DeezerArtist;
  album?: DeezerAlbum;
}

interface DeezerErrorPayload {
  error?: { type?: unknown; message?: unknown; code?: unknown };
}

export interface DeezerPreview {
  url: string;
  /** Epoch milliseconds parsed from the signed URL, when present. */
  expiresAt: number | null;
  previewMs: number;
}

function requiredText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function httpsUrl(value: unknown): string | undefined {
  const text = requiredText(value);
  if (text === null || !URL.canParse(text)) return undefined;
  return new URL(text).protocol === 'https:' ? text : undefined;
}

function bareTrackId(id: string): string | null {
  if (!id.startsWith(ID_PREFIX)) return null;
  const bare = id.slice(ID_PREFIX.length);
  return /^[0-9]{1,20}$/.test(bare) ? bare : null;
}

/** Signed preview URLs carry `?hdnea=exp=<unix seconds>~acl=...~hmac=...`. */
export function previewExpiry(url: string): number | null {
  const match = /(?:^|[?&~=])exp=(\d{9,12})(?:~|&|$)/.exec(new URL(url).search);
  return match?.[1] === undefined ? null : Number(match[1]) * 1000;
}

function deezerError(payload: unknown): { code: number; message: string } | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const error = (payload as DeezerErrorPayload).error;
  if (typeof error !== 'object' || error === null) return null;
  return {
    code: Number(error.code) || 0,
    message: requiredText(error.message) ?? requiredText(error.type) ?? 'Deezer error',
  };
}

export function asDeezerTrack(payload: unknown): Track | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const item = payload as DeezerTrackPayload;
  const id = Number(item.id);
  const title = requiredText(item.title);
  const artist = requiredText(item.artist?.name);
  if (!Number.isInteger(id) || id <= 0 || title === null || artist === null) return null;
  // Unreadable tracks and tracks without a clip cannot be played by the host.
  if (item.readable === false || requiredText(item.preview) === null) return null;

  const album = requiredText(item.album?.title);
  const durationSeconds = Number(item.duration);
  const artUrl =
    httpsUrl(item.album?.cover_big) ??
    httpsUrl(item.album?.cover_medium) ??
    httpsUrl(item.album?.cover);
  const externalUrl = httpsUrl(item.link);
  return {
    id: `${ID_PREFIX}${id}`,
    title: title.slice(0, 80),
    artist: artist.slice(0, 80),
    ...(album === null ? {} : { album: album.slice(0, 80) }),
    ...(Number.isFinite(durationSeconds) && durationSeconds > 0
      ? { durationMs: Math.round(durationSeconds * 1000) }
      : {}),
    ...(artUrl === undefined ? {} : { artUrl }),
    source: 'deezer',
    attribution: '30-second preview via Deezer',
    ...(externalUrl === undefined ? {} : { externalUrl }),
  };
}

/**
 * Deezer's developer terms (section IV) limit the free API to non-commercial
 * use, so it is never on by default: YouTube (D-024) is the product catalog and
 * Deezer is an explicit opt-in for offline-style playtests.
 */
export function deezerPreviewsEnabled(env: NodeJS.ProcessEnv): boolean {
  const flag = env.AUX_DEEZER_PREVIEWS?.trim().toLowerCase();
  return flag === '1' || flag === 'true' || flag === 'on';
}

export class DeezerCatalogProvider implements ApprovedMusicCatalog {
  private readonly tracks: TtlCache<Track>;
  private readonly searches: TtlCache<Track[]>;

  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    now: () => number = Date.now,
  ) {
    this.tracks = new TtlCache(TRACK_CACHE_TTL_MS, now, CACHE_MAX_ENTRIES);
    this.searches = new TtlCache(SEARCH_CACHE_TTL_MS, now, CACHE_MAX_ENTRIES);
  }

  static fromEnv(env: NodeJS.ProcessEnv): DeezerCatalogProvider | null {
    return deezerPreviewsEnabled(env) ? new DeezerCatalogProvider() : null;
  }

  /** Deezer is a remote index; there is no local list to seed chicken picks from. */
  listTracks(): Track[] {
    return [];
  }

  playableTrack(track: Track, roomCode: string): Track | null {
    if (bareTrackId(track.id) === null) return null;
    return {
      ...track,
      source: 'deezer',
      playableMs: DEEZER_PREVIEW_MS,
      playbackUrl: `/api/v1/rooms/${encodeURIComponent(roomCode)}/deezer/${encodeURIComponent(track.id)}/preview`,
    };
  }

  async search(query: string, limit = 20): Promise<Track[]> {
    const cap = Math.min(20, Math.max(1, Math.floor(limit)));
    const term = query.trim();
    if (term === '') return [];
    const cacheKey = `${term.toLowerCase()}|${cap}`;
    const cached = this.searches.get(cacheKey);
    if (cached !== undefined) return cached.map((track) => ({ ...track }));

    const payload = await this.request(`/search?q=${encodeURIComponent(term)}&limit=${cap}`);
    const failure = deezerError(payload);
    if (failure !== null) throw new MusicCatalogError('CATALOG_DOWN', failure.message);
    const data = (payload as { data?: unknown }).data;
    const tracks: Track[] = [];
    for (const item of Array.isArray(data) ? data : []) {
      const track = asDeezerTrack(item);
      if (track === null) continue;
      this.tracks.set(track.id, track);
      tracks.push(track);
      if (tracks.length >= cap) break;
    }
    this.searches.set(cacheKey, tracks);
    return tracks.map((track) => ({ ...track }));
  }

  async getTrack(id: string): Promise<Track> {
    const cached = this.tracks.get(id);
    if (cached !== undefined) return { ...cached };
    const bare = bareTrackId(id);
    if (bare === null) throw new MusicCatalogError('TRACK_UNPLAYABLE');
    const track = asDeezerTrack(await this.fetchTrack(bare));
    if (track === null || track.id !== id) throw new MusicCatalogError('TRACK_UNPLAYABLE');
    this.tracks.set(track.id, track);
    return { ...track };
  }

  /** Always fetched fresh: the CDN signature in a preview URL expires quickly. */
  async preview(id: string): Promise<DeezerPreview> {
    const bare = bareTrackId(id);
    if (bare === null) throw new MusicCatalogError('TRACK_UNPLAYABLE');
    const payload = await this.fetchTrack(bare);
    const url = httpsUrl((payload as DeezerTrackPayload).preview);
    if ((payload as DeezerTrackPayload).readable === false || url === undefined) {
      throw new MusicCatalogError('TRACK_UNPLAYABLE', 'Deezer has no preview for this track');
    }
    return { url, expiresAt: previewExpiry(url), previewMs: DEEZER_PREVIEW_MS };
  }

  private async fetchTrack(bareId: string): Promise<unknown> {
    const payload = await this.request(`/track/${bareId}`);
    const failure = deezerError(payload);
    if (failure === null) return payload;
    if (failure.code === DEEZER_DATA_NOT_FOUND) throw new MusicCatalogError('TRACK_UNPLAYABLE');
    throw new MusicCatalogError('CATALOG_DOWN', failure.message);
  }

  private async request(path: string): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${DEEZER_API_BASE}${path}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(8_000),
      });
    } catch (error) {
      throw new MusicCatalogError(
        'CATALOG_DOWN',
        error instanceof Error ? error.message : 'Deezer request failed',
      );
    }
    if (!response.ok) {
      throw new MusicCatalogError('CATALOG_DOWN', `Deezer returned ${response.status}`);
    }
    try {
      return await response.json();
    } catch {
      throw new MusicCatalogError('CATALOG_DOWN', 'Deezer returned invalid JSON');
    }
  }
}
