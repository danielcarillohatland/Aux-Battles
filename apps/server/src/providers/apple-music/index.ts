/** Apple Music catalog metadata through the official Apple Music API. */
import type { Track } from '@aux/shared';
import { MusicCatalogError, type ApprovedMusicCatalog } from '../music-provider.js';

type FetchLike = typeof fetch;

interface AppleArtwork {
  url?: unknown;
}

interface AppleSongAttributes {
  name?: unknown;
  artistName?: unknown;
  albumName?: unknown;
  durationInMillis?: unknown;
  artwork?: AppleArtwork;
  url?: unknown;
}

interface AppleSongResource {
  id?: unknown;
  attributes?: AppleSongAttributes;
}

function requiredText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function artworkUrl(value: unknown): string | undefined {
  const template = requiredText(value);
  if (template === null) return undefined;
  const url = template.replace('{w}', '512').replace('{h}', '512');
  return URL.canParse(url) ? url : undefined;
}

function asTrack(resource: AppleSongResource): Track | null {
  const bareId = requiredText(resource.id);
  const attributes = resource.attributes;
  const title = requiredText(attributes?.name);
  const artist = requiredText(attributes?.artistName);
  if (bareId === null || title === null || artist === null) return null;

  const album = requiredText(attributes?.albumName);
  const duration = Number(attributes?.durationInMillis);
  const artUrl = artworkUrl(attributes?.artwork?.url);
  const externalUrl = requiredText(attributes?.url);
  return {
    id: `apple-music:${bareId}`,
    title: title.slice(0, 80),
    artist: artist.slice(0, 80),
    ...(album === null ? {} : { album: album.slice(0, 80) }),
    ...(Number.isInteger(duration) && duration > 0 ? { durationMs: duration } : {}),
    ...(artUrl === undefined ? {} : { artUrl }),
    source: 'apple_music',
    attribution: 'Provided by Apple Music',
    ...(externalUrl !== null && URL.canParse(externalUrl) ? { externalUrl } : {}),
  };
}

function bareTrackId(id: string): string | null {
  if (!id.startsWith('apple-music:')) return null;
  const bare = id.slice('apple-music:'.length);
  return /^[A-Za-z0-9._-]+$/.test(bare) ? bare : null;
}

export interface AppleMusicWebConfiguration {
  developerToken: string;
  storefront: string;
}

const REQUEST_TIMEOUT_MS = 8_000;
const CACHE_MAX_ENTRIES = 2_000;

export class AppleMusicCatalogProvider implements ApprovedMusicCatalog {
  private readonly cache = new Map<string, Track>();

  constructor(
    private readonly developerToken: string,
    private readonly storefront = 'us',
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    if (developerToken.trim() === '') throw new Error('Apple Music developer token is required');
    if (!/^[a-z]{2}$/i.test(storefront)) {
      throw new Error('Apple Music storefront must be a two-letter country code');
    }
  }

  static fromEnv(env: NodeJS.ProcessEnv): AppleMusicCatalogProvider | null {
    const token = env.AUX_APPLE_MUSIC_DEVELOPER_TOKEN?.trim();
    if (!token) return null;
    return new AppleMusicCatalogProvider(
      token,
      env.AUX_APPLE_MUSIC_STOREFRONT?.trim().toLowerCase() || 'us',
    );
  }

  webConfiguration(): AppleMusicWebConfiguration {
    return { developerToken: this.developerToken, storefront: this.storefront.toLowerCase() };
  }

  listTracks(): Track[] {
    return [...this.cache.values()].map((track) => ({ ...track }));
  }

  /**
   * Apple Music metadata was canonicalized by getTrack before it entered the
   * submission store, so the checkpointed copy stays playable after a process
   * restart; MusicKit resolves and streams the actual song on the host.
   */
  playableTrack(track: Track, _roomCode: string): Track | null {
    return bareTrackId(track.id) === null ? null : { ...track };
  }

  async search(query: string, limit = 20): Promise<Track[]> {
    const cap = Math.min(20, Math.max(1, Math.floor(limit)));
    const payload = await this.request(
      `/v1/catalog/${this.storefront.toLowerCase()}/search?term=${encodeURIComponent(query)}&types=songs&limit=${cap}`,
    );
    const resources = this.songResources(payload, true);
    const tracks: Track[] = [];
    for (const resource of resources) {
      const track = asTrack(resource);
      if (track === null) continue;
      this.remember(track);
      tracks.push({ ...track });
      if (tracks.length >= cap) break;
    }
    return tracks;
  }

  async getTrack(id: string): Promise<Track> {
    const cached = this.cache.get(id);
    if (cached !== undefined) return { ...cached };
    const bareId = bareTrackId(id);
    if (bareId === null) throw new MusicCatalogError('TRACK_UNPLAYABLE');
    const payload = await this.request(
      `/v1/catalog/${this.storefront.toLowerCase()}/songs/${encodeURIComponent(bareId)}`,
      true,
    );
    const resource = this.songResources(payload, false)[0];
    const track = resource === undefined ? null : asTrack(resource);
    if (track === null || track.id !== id) throw new MusicCatalogError('TRACK_UNPLAYABLE');
    this.remember(track);
    return { ...track };
  }

  private songResources(payload: unknown, search: boolean): AppleSongResource[] {
    if (typeof payload !== 'object' || payload === null) return [];
    const root = payload as Record<string, unknown>;
    if (!search) return Array.isArray(root.data) ? (root.data as AppleSongResource[]) : [];
    const results = root.results;
    if (typeof results !== 'object' || results === null) return [];
    const songs = (results as Record<string, unknown>).songs;
    if (typeof songs !== 'object' || songs === null) return [];
    const data = (songs as Record<string, unknown>).data;
    return Array.isArray(data) ? (data as AppleSongResource[]) : [];
  }

  /** Bounded: a long-lived process must not grow with every search result. */
  private remember(track: Track): void {
    if (!this.cache.has(track.id) && this.cache.size >= CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(track.id, track);
  }

  private async request(path: string, missingIsUnplayable = false): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`https://api.music.apple.com${path}`, {
        headers: { authorization: `Bearer ${this.developerToken}`, accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      // Never surface transport internals; callers only need the category.
      throw new MusicCatalogError('CATALOG_DOWN', 'Apple Music request failed');
    }
    if (!response.ok) {
      if (missingIsUnplayable && response.status === 404) {
        throw new MusicCatalogError('TRACK_UNPLAYABLE');
      }
      throw new MusicCatalogError('CATALOG_DOWN', `Apple Music returned ${response.status}`);
    }
    try {
      return await response.json();
    } catch {
      throw new MusicCatalogError('CATALOG_DOWN', 'Apple Music returned invalid JSON');
    }
  }
}
