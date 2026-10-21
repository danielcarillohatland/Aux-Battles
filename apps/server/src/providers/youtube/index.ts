/**
 * YouTube catalog: song search through the YouTube Data API v3 and playback of
 * the official embedded player on the host screen (docs/youtube-music.md, D-024).
 *
 * The API key never leaves the server. A search costs 100 quota units plus one
 * unit for the batched video-details call, so results are cached for a long
 * time and the search route's per-client limit applies on top. The search hit
 * *is* the video, so playback needs no further quota.
 */
import type { Track } from '@aux/shared';
import { MusicCatalogError, type ApprovedMusicCatalog } from '../music-provider.js';
import { ITunesSongIndex, type SongHit, type SongIndex } from '../song-index/itunes.js';
import { TtlCache } from '../../core/ttl-cache.js';

type FetchLike = typeof fetch;

export const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';
const ID_PREFIX = 'youtube:';
/** Songs picked from the metadata gallery, resolved to a video at submission time. */
const SONG_PREFIX = 'song:';
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const SEARCH_CACHE_TTL_MS = 6 * 60 * 60_000;
const TRACK_CACHE_TTL_MS = 24 * 60 * 60_000;
const CACHE_MAX_ENTRIES = 2_000;
/** Skip shorts/clips and full albums, mixes, or live sets. */
const MIN_DURATION_MS = 30_000;
const MAX_DURATION_MS = 12 * 60_000;

interface YouTubeThumbnails {
  medium?: { url?: unknown };
  high?: { url?: unknown };
  default?: { url?: unknown };
}

interface YouTubeVideoResource {
  id?: unknown;
  snippet?: {
    title?: unknown;
    channelTitle?: unknown;
    thumbnails?: YouTubeThumbnails;
    liveBroadcastContent?: unknown;
  };
  contentDetails?: {
    duration?: unknown;
    regionRestriction?: { allowed?: unknown; blocked?: unknown };
  };
  status?: { embeddable?: unknown; privacyStatus?: unknown };
}

interface YouTubeSearchResource {
  id?: { videoId?: unknown };
}

interface YouTubeErrorPayload {
  error?: { code?: unknown; message?: unknown; errors?: Array<{ reason?: unknown }> };
}

export interface YouTubeVideoSummary {
  videoId: string;
  title: string;
  channelTitle: string;
}

function requiredText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function httpsUrl(value: unknown): string | undefined {
  const text = requiredText(value);
  if (text === null || !URL.canParse(text)) return undefined;
  return new URL(text).protocol === 'https:' ? text : undefined;
}

export function youtubeVideoIdOf(trackId: string): string | null {
  if (!trackId.startsWith(ID_PREFIX)) return null;
  const bare = trackId.slice(ID_PREFIX.length);
  return VIDEO_ID.test(bare) ? bare : null;
}

/** ISO-8601 durations as returned by videos.list (`PT3M20S`, `PT1H2M`, `P0D`). */
export function parseIsoDurationMs(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value);
  if (match === null) return undefined;
  const [, days = '0', hours = '0', minutes = '0', seconds = '0'] = match;
  const total = ((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds);
  return total > 0 ? total * 1000 : undefined;
}

const NOISE =
  /\s*[([{][^)\]}]*\b(official|video|audio|lyrics?|visuali[sz]er|hd|hq|4k|remaster(?:ed)?(?:\s+\d{4})?|explicit|clean|mv|m\/v|music video|live)\b[^)\]}]*[)\]}]/gi;
const CHANNEL_NOISE = /\s*-\s*topic$|vevo$|\s*official$/i;

/**
 * Best-effort "Artist - Title" split of a video title. Music videos are
 * overwhelmingly titled that way; otherwise the channel name stands in for the
 * artist (with YouTube's auto-generated " - Topic" and VEVO suffixes removed).
 */
export function splitVideoTitle(
  rawTitle: string,
  channelTitle: string,
): { title: string; artist: string } {
  const cleaned = rawTitle
    .replace(NOISE, '')
    .replace(/\s*\|.*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  const separator = /\s+[-–—:]\s+/.exec(cleaned);
  let title = cleaned;
  let artist = channelTitle.replace(CHANNEL_NOISE, '').trim();
  if (separator !== null && separator.index > 0) {
    const left = cleaned.slice(0, separator.index).trim();
    const right = cleaned.slice(separator.index + separator[0].length).trim();
    if (left !== '' && right !== '') {
      artist = left;
      title = right;
    }
  }
  title = title.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();
  return {
    title: (title || cleaned || rawTitle).slice(0, 80),
    artist: (artist || channelTitle || 'YouTube').slice(0, 80),
  };
}

/** Region-restricted videos error inside the iframe; drop them up front when a region is known. */
export function playableInRegion(
  resource: YouTubeVideoResource,
  region: string | undefined,
): boolean {
  if (region === undefined) return true;
  const restriction = resource.contentDetails?.regionRestriction;
  if (restriction === undefined) return true;
  const allowed = Array.isArray(restriction.allowed) ? (restriction.allowed as unknown[]) : null;
  const blocked = Array.isArray(restriction.blocked) ? (restriction.blocked as unknown[]) : [];
  if (blocked.includes(region)) return false;
  return allowed === null || allowed.includes(region);
}

export function asYouTubeTrack(resource: YouTubeVideoResource): Track | null {
  const videoId = requiredText(resource.id);
  const rawTitle = requiredText(resource.snippet?.title);
  const channel = requiredText(resource.snippet?.channelTitle) ?? 'YouTube';
  if (videoId === null || !VIDEO_ID.test(videoId) || rawTitle === null) return null;
  if (resource.status?.embeddable === false) return null;
  if (resource.status?.privacyStatus !== undefined && resource.status.privacyStatus !== 'public') {
    return null;
  }
  const live = resource.snippet?.liveBroadcastContent;
  if (typeof live === 'string' && live !== 'none') return null;
  const durationMs = parseIsoDurationMs(resource.contentDetails?.duration);
  if (durationMs !== undefined && (durationMs < MIN_DURATION_MS || durationMs > MAX_DURATION_MS)) {
    return null;
  }
  const thumbs = resource.snippet?.thumbnails;
  const artUrl =
    httpsUrl(thumbs?.high?.url) ?? httpsUrl(thumbs?.medium?.url) ?? httpsUrl(thumbs?.default?.url);
  const { title, artist } = splitVideoTitle(rawTitle, channel);
  return {
    id: `${ID_PREFIX}${videoId}`,
    title,
    artist,
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(artUrl === undefined ? {} : { artUrl }),
    source: 'youtube',
    attribution: `Video from YouTube · ${channel.slice(0, 60)}`,
    externalUrl: `https://www.youtube.com/watch?v=${videoId}`,
  };
}

const BAD_VERSION =
  /\b(cover|karaoke|live|remix|sped ?up|slowed|nightcore|reaction|tutorial|instrumental|8d|lyrics?|parody|mashup|acoustic|reverb)\b/i;

function normalizeText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function songVideoIdOf(trackId: string): string | null {
  if (!trackId.startsWith(SONG_PREFIX)) return null;
  const bare = trackId.slice(SONG_PREFIX.length);
  return /^\d{1,20}$/.test(bare) ? bare : null;
}

/**
 * Rank candidate videos for a known song: official artist/VEVO/Topic channels
 * and exact title matches win, alternate versions lose unless the song itself
 * is one, and the runtime should be close to the catalog duration.
 */
export function scoreVideoForSong(
  video: { title: string; channelTitle: string; durationMs?: number | undefined },
  song: { title: string; artist: string; durationMs?: number | undefined },
): number {
  const title = normalizeText(video.title);
  const channel = normalizeText(video.channelTitle);
  const songTitle = normalizeText(song.title);
  const artist = normalizeText(song.artist);
  const compactArtist = artist.replace(/\s+/g, '');
  const compactChannel = channel.replace(/\s+/g, '');
  let score = 0;
  // The video must be THIS song: view-count ordering also returns the artist's other hits.
  if (songTitle !== '' && title.includes(songTitle)) score += 3;
  else score -= 8;
  if (artist !== '' && (title.includes(artist) || channel.includes(artist))) score += 2;
  else if (compactArtist !== '' && compactChannel.includes(compactArtist)) score += 2;
  const topic = /\btopic$/.test(channel);
  const officialChannel = topic || /vevo$/.test(channel);
  if (/vevo$/.test(channel)) score += 2;
  // Auto-generated "Artist - Topic" art tracks pass the API's embeddable flag
  // yet routinely show "This video is unavailable" inside third-party iframes.
  if (topic) score -= 3;
  if (/\bofficial (music )?(video|audio)\b/.test(title)) score += 1;
  // Uploads from unrelated channels are usually covers or re-uploads even when
  // the title does not say so.
  if (
    !officialChannel &&
    !(artist !== '' && channel.includes(artist)) &&
    !(compactArtist !== '' && compactChannel.includes(compactArtist))
  ) {
    score -= 2.5;
  }
  if (/\bofficial\b/.test(title)) score += 1;
  if (BAD_VERSION.test(video.title) && !BAD_VERSION.test(song.title)) score -= 3;
  if (song.durationMs !== undefined && video.durationMs !== undefined) {
    const drift = Math.abs(video.durationMs - song.durationMs) / song.durationMs;
    score += drift <= 0.12 ? 2 : drift <= 0.3 ? 1 : -1;
  }
  return score;
}

export interface VideoCandidate {
  track: Track;
  /** Untouched upload title: "(Lyrics)", "(Karaoke)" etc. must stay visible to the scorer. */
  rawTitle?: string;
  channelTitle?: string;
}

/** All candidates that are plausibly this song, best first. */
export function rankVideos<T extends VideoCandidate>(
  candidates: readonly T[],
  song: { title: string; artist: string; durationMs?: number | undefined },
): Array<{ item: T; score: number }> {
  return candidates
    .map((item, position) => {
      const channel =
        item.channelTitle ?? item.track.attribution?.replace(/^Video from YouTube · /, '') ?? '';
      const score =
        scoreVideoForSong(
          {
            title: item.rawTitle ?? `${item.track.title} ${item.track.artist}`,
            channelTitle: channel,
            durationMs: item.track.durationMs,
          },
          song,
        ) -
        position * 0.1;
      return { item, score };
    })
    .sort((a, b) => b.score - a.score);
}

export function pickBestVideo<T extends VideoCandidate>(
  candidates: readonly T[],
  song: { title: string; artist: string; durationMs?: number | undefined },
): { item: T; score: number } | undefined {
  return rankVideos(candidates, song)[0];
}

/** Candidates scoring below this are a different song; never fall back to them. */
const SAME_SONG_FLOOR = -2;
const MAX_CANDIDATES = 6;

/** Below this the best candidate is probably a different song; try another search. */
const ACCEPTABLE_VIDEO_SCORE = 1;

/** Gallery result: catalog metadata now, video resolution when submitted. */
export function songHitAsTrack(hit: SongHit): Track {
  return {
    id: `${SONG_PREFIX}${hit.id}`,
    title: hit.title,
    artist: hit.artist,
    ...(hit.album === undefined ? {} : { album: hit.album }),
    ...(hit.durationMs === undefined ? {} : { durationMs: hit.durationMs }),
    // A song index does not grant rights to reuse its promotional artwork.
    source: 'youtube',
    attribution: 'Plays on YouTube',
    ...(hit.storeUrl === undefined ? {} : { externalUrl: hit.storeUrl }),
  };
}

export interface YouTubeCatalogOptions {
  apiKey: string;
  /** ISO 3166-1 alpha-2 region used to rank and filter search results. */
  regionCode?: string;
  /**
   * Song metadata gallery for player search. When present, search costs no
   * YouTube quota and only submitted songs are resolved to a video. `null`
   * searches YouTube directly.
   */
  songIndex?: SongIndex | null;
  fetchImpl?: FetchLike;
  now?: () => number;
}

export class YouTubeCatalogProvider implements ApprovedMusicCatalog {
  private readonly apiKey: string;
  private readonly regionCode: string | undefined;
  private readonly fetchImpl: FetchLike;
  private readonly tracks: TtlCache<Track>;
  private readonly searches: TtlCache<Track[]>;
  private readonly inflight = new Map<string, Promise<Track[]>>();
  private readonly songIndex: SongIndex | null;
  private readonly resolved: TtlCache<Track>;

  constructor(options: YouTubeCatalogOptions) {
    this.apiKey = options.apiKey.trim();
    if (this.apiKey === '') throw new Error('YouTube Data API key is required');
    const region = options.regionCode?.trim().toUpperCase();
    if (region !== undefined && region !== '' && !/^[A-Z]{2}$/.test(region)) {
      throw new Error('YouTube region must be a two-letter country code');
    }
    this.regionCode = region || undefined;
    this.fetchImpl = options.fetchImpl ?? fetch;
    const now = options.now ?? Date.now;
    this.tracks = new TtlCache(TRACK_CACHE_TTL_MS, now, CACHE_MAX_ENTRIES);
    this.searches = new TtlCache(SEARCH_CACHE_TTL_MS, now, CACHE_MAX_ENTRIES);
    this.resolved = new TtlCache(TRACK_CACHE_TTL_MS, now, CACHE_MAX_ENTRIES);
    this.songIndex =
      options.songIndex === undefined
        ? new ITunesSongIndex({
            ...(this.regionCode === undefined ? {} : { country: this.regionCode }),
            fetchImpl: this.fetchImpl,
            now,
          })
        : options.songIndex;
  }

  static fromEnv(env: NodeJS.ProcessEnv): YouTubeCatalogProvider | null {
    const apiKey = env.AUX_YOUTUBE_API_KEY?.trim();
    if (!apiKey) return null;
    const region = env.AUX_YOUTUBE_REGION?.trim();
    return new YouTubeCatalogProvider({
      apiKey,
      ...(region ? { regionCode: region } : {}),
      ...(env.AUX_SONG_SEARCH?.trim() === '0' ? { songIndex: null } : {}),
    });
  }

  /** Remote index: nothing local to seed chicken picks from. */
  listTracks(): Track[] {
    return [];
  }

  /** The stored track already names the video; the host embeds it directly. */
  playableTrack(track: Track, _roomCode: string): Track | null {
    return youtubeVideoIdOf(track.id) === null ? null : { ...track, source: 'youtube' };
  }

  async search(query: string, limit = 20): Promise<Track[]> {
    const cap = Math.min(20, Math.max(1, Math.floor(limit)));
    const term = query.trim().replace(/\s+/g, ' ');
    if (term === '') return [];
    if (this.songIndex !== null) {
      let hits: SongHit[];
      try {
        hits = await this.songIndex.search(term, cap);
      } catch (error) {
        throw new MusicCatalogError(
          'CATALOG_DOWN',
          error instanceof Error ? error.message : 'song search failed',
        );
      }
      return hits.map((hit) => songHitAsTrack(hit));
    }
    const cacheKey = term.toLowerCase();
    const cached = this.searches.get(cacheKey);
    if (cached !== undefined) return cached.slice(0, cap).map((track) => ({ ...track }));
    // Identical concurrent queries (several phones typing the same hit) share
    // one quota-costing request.
    let pending = this.inflight.get(cacheKey);
    if (pending === undefined) {
      pending = this.fetchSearch(term).finally(() => this.inflight.delete(cacheKey));
      this.inflight.set(cacheKey, pending);
    }
    const tracks = await pending;
    this.searches.set(cacheKey, tracks);
    return tracks.slice(0, cap).map((track) => ({ ...track }));
  }

  async getTrack(id: string): Promise<Track> {
    const songId = songVideoIdOf(id);
    if (songId !== null) return this.resolveSong(songId);
    const cached = this.tracks.get(id);
    if (cached !== undefined) return { ...cached };
    const videoId = youtubeVideoIdOf(id);
    if (videoId === null) throw new MusicCatalogError('TRACK_UNPLAYABLE');
    const track = (await this.fetchVideos([videoId]))[0]?.track;
    if (track === undefined || track.id !== id) throw new MusicCatalogError('TRACK_UNPLAYABLE');
    this.tracks.set(track.id, track);
    return { ...track };
  }

  /** Song gallery pick → the best embeddable official video, with catalog metadata. */
  private async resolveSong(songId: string): Promise<Track> {
    const cached = this.resolved.get(songId);
    if (cached !== undefined) return { ...cached };
    if (this.songIndex === null) throw new MusicCatalogError('TRACK_UNPLAYABLE');
    let hit: SongHit | null;
    try {
      hit = await this.songIndex.lookup(songId);
    } catch (error) {
      throw new MusicCatalogError(
        'CATALOG_DOWN',
        error instanceof Error ? error.message : 'song lookup failed',
      );
    }
    if (hit === null) throw new MusicCatalogError('TRACK_UNPLAYABLE');
    // Most-viewed first surfaces the official VEVO/Topic upload; relevance
    // ordering favours lyric videos and re-uploads. Fall back to relevance
    // only when no popular candidate is actually this song.
    // "official" + most-viewed surfaces the label/artist upload; relevance
    // ordering favours lyric videos and re-uploads, so it is only a fallback.
    const query = `${hit.artist} ${hit.title}`;
    const popular = await this.searchVideos(`${query} official`, 10, 'viewCount');
    let ranked = rankVideos(popular, hit);
    if (ranked[0] === undefined || ranked[0].score < ACCEPTABLE_VIDEO_SCORE) {
      const relevant = await this.searchVideos(query, 8, 'relevance');
      const seen = new Set(popular.map(({ track }) => track.id));
      ranked = rankVideos(
        [...popular, ...relevant.filter(({ track }) => !seen.has(track.id))],
        hit,
      );
    }
    const usable = ranked.filter(({ score }) => score >= SAME_SONG_FLOOR).slice(0, MAX_CANDIDATES);
    const best = usable[0];
    if (best === undefined) {
      throw new MusicCatalogError('TRACK_UNPLAYABLE', 'no embeddable video found for this song');
    }
    const videoCandidates = usable.flatMap(({ item }) => {
      const id = youtubeVideoIdOf(item.track.id);
      return id === null ? [] : [id];
    });
    const chosen = best.item.track;
    const channel = chosen.attribution?.replace(/^Video from YouTube · /, '') ?? 'YouTube';
    const track: Track = {
      id: chosen.id,
      title: hit.title,
      artist: hit.artist,
      ...(hit.album === undefined ? {} : { album: hit.album }),
      ...(chosen.durationMs === undefined
        ? hit.durationMs === undefined
          ? {}
          : { durationMs: hit.durationMs }
        : { durationMs: chosen.durationMs }),
      // Attribute playback with the selected video's own YouTube thumbnail.
      ...(chosen.artUrl === undefined ? {} : { artUrl: chosen.artUrl }),
      source: 'youtube',
      attribution: `Video from YouTube · ${channel}`,
      externalUrl: `https://www.youtube.com/watch?v=${youtubeVideoIdOf(chosen.id) ?? ''}`,
      videoCandidates,
    };
    this.resolved.set(songId, track);
    this.tracks.set(track.id, track);
    return { ...track };
  }

  private async fetchSearch(term: string): Promise<Track[]> {
    const tracks = (await this.searchVideos(term, 20, 'relevance')).map(({ track }) => track);
    for (const track of tracks) this.tracks.set(track.id, track);
    return tracks;
  }

  /** search.list (100 units) + one videos.list for the batch. */
  private async searchVideos(
    term: string,
    maxResults: number,
    order: 'relevance' | 'viewCount',
  ): Promise<VideoCandidate[]> {
    const params = new URLSearchParams({
      part: 'snippet',
      type: 'video',
      videoCategoryId: '10',
      // No videoSyndicated filter: it hides most label/VEVO uploads even though
      // they embed fine; the iframe fallback chain handles the rest.
      videoEmbeddable: 'true',
      order,
      maxResults: String(maxResults),
      q: term,
      key: this.apiKey,
    });
    if (this.regionCode !== undefined) params.set('regionCode', this.regionCode);
    const payload = (await this.request(`/search?${params.toString()}`)) as {
      items?: unknown;
    };
    const ids: string[] = [];
    for (const item of Array.isArray(payload.items) ? payload.items : []) {
      const videoId = requiredText((item as YouTubeSearchResource).id?.videoId);
      if (videoId !== null && VIDEO_ID.test(videoId) && !ids.includes(videoId)) ids.push(videoId);
    }
    if (ids.length === 0) return [];
    return this.fetchVideos(ids);
  }

  /** One unit for up to 50 ids: duration, embeddability, privacy, thumbnails. */
  private async fetchVideos(videoIds: string[]): Promise<VideoCandidate[]> {
    const params = new URLSearchParams({
      part: 'snippet,contentDetails,status',
      id: videoIds.slice(0, 50).join(','),
      key: this.apiKey,
    });
    const payload = (await this.request(`/videos?${params.toString()}`)) as { items?: unknown };
    const byId = new Map<string, VideoCandidate>();
    for (const item of Array.isArray(payload.items) ? payload.items : []) {
      const resource = item as YouTubeVideoResource;
      if (!playableInRegion(resource, this.regionCode)) continue;
      const track = asYouTubeTrack(resource);
      if (track === null) continue;
      byId.set(track.id, {
        track,
        ...(typeof resource.snippet?.title === 'string'
          ? { rawTitle: resource.snippet.title }
          : {}),
        ...(typeof resource.snippet?.channelTitle === 'string'
          ? { channelTitle: resource.snippet.channelTitle }
          : {}),
      });
    }
    // Preserve YouTube's ordering from the search response.
    return videoIds.flatMap((videoId) => {
      const candidate = byId.get(`${ID_PREFIX}${videoId}`);
      return candidate === undefined ? [] : [candidate];
    });
  }

  private async request(pathWithQuery: string): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${YOUTUBE_API_BASE}${pathWithQuery}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(8_000),
      });
    } catch (error) {
      throw new MusicCatalogError(
        'CATALOG_DOWN',
        error instanceof Error ? error.message : 'YouTube request failed',
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new MusicCatalogError('CATALOG_DOWN', 'YouTube returned invalid JSON');
    }
    if (!response.ok) {
      const error = (payload as YouTubeErrorPayload | null)?.error;
      const reasons = (error?.errors ?? []).map((item) => String(item.reason ?? ''));
      if (reasons.includes('quotaExceeded') || reasons.includes('dailyLimitExceeded')) {
        throw new MusicCatalogError('CATALOG_DOWN', 'YouTube Data API quota exhausted for today');
      }
      throw new MusicCatalogError(
        'CATALOG_DOWN',
        requiredText(error?.message) ?? `YouTube returned ${response.status}`,
      );
    }
    return payload;
  }
}
