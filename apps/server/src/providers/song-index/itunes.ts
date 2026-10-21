/**
 * Song metadata index backed by the iTunes Search API (D-027): free, key-less,
 * popularity-ranked. Used for song titles, artists, album names, and durations.
 * Apple's promotional artwork and preview clips are deliberately omitted from
 * game search results; metadata keeps the store link for attribution.
 */
export interface SongHit {
  /** Store track id, digits only. */
  id: string;
  title: string;
  artist: string;
  album?: string;
  durationMs?: number;
  artUrl?: string;
  storeUrl?: string;
}

export interface SongIndex {
  search(term: string, limit: number): Promise<SongHit[]>;
  lookup(id: string): Promise<SongHit | null>;
}

export class SongIndexError extends Error {}

type FetchLike = typeof fetch;

const SEARCH_TTL_MS = 10 * 60_000;
const LOOKUP_TTL_MS = 24 * 60 * 60_000;
const CACHE_MAX = 2_000;

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function https(value: unknown): string | undefined {
  const url = text(value);
  if (url === null || !URL.canParse(url)) return undefined;
  return new URL(url).protocol === 'https:' ? url : undefined;
}

export function asSongHit(item: unknown): SongHit | null {
  if (typeof item !== 'object' || item === null) return null;
  const r = item as Record<string, unknown>;
  if (r.kind !== undefined && r.kind !== 'song') return null;
  const id = Number(r.trackId);
  const title = text(r.trackName);
  const artist = text(r.artistName);
  if (!Number.isInteger(id) || id <= 0 || title === null || artist === null) return null;
  const album = text(r.collectionName);
  const durationMs = Number(r.trackTimeMillis);
  const storeUrl = https(r.trackViewUrl);
  return {
    id: String(id),
    title: title.slice(0, 80),
    artist: artist.slice(0, 80),
    ...(album === null ? {} : { album: album.slice(0, 80) }),
    ...(Number.isInteger(durationMs) && durationMs > 0 ? { durationMs } : {}),
    ...(storeUrl === undefined ? {} : { storeUrl }),
  };
}

const VARIANT =
  /\b(remix|version|cover|live|karaoke|sped ?up|slowed|instrumental|tribute|acoustic|edit|mix|remaster(?:ed)?|demo|rehearsal|in the style of)\b/i;

function norm(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Store relevance is popularity-biased per storefront and happily ranks a
 * "(Country Version)" above the original. Nudge exact-title originals up and
 * alternate versions down while keeping the store order otherwise.
 */
export function rankSongHits(hits: readonly SongHit[], term: string): SongHit[] {
  const q = norm(term);
  const seen = new Set<string>();
  // The same song appearing on several releases (album, single, compilation)
  // is the closest thing the store gives us to a popularity signal.
  const releases = new Map<string, number>();
  for (const hit of hits) {
    const key = `${norm(hit.title)}|${norm(hit.artist)}`;
    releases.set(key, (releases.get(key) ?? 0) + 1);
  }
  return hits
    .map((hit, position) => {
      const title = norm(hit.title);
      const key = `${title}|${norm(hit.artist)}`;
      let score = -position * 0.05 + Math.min(3, (releases.get(key) ?? 1) - 1) * 0.6;
      if (title === q) score += 3;
      else if (q !== '' && (title.startsWith(q) || `${title} ${norm(hit.artist)}` === q))
        score += 1.5;
      if (VARIANT.test(hit.title) && !VARIANT.test(term)) score -= 2;
      return { hit, score };
    })
    .sort((a, b) => b.score - a.score)
    .map(({ hit }) => hit)
    .filter((hit) => {
      const key = `${norm(hit.title)}|${norm(hit.artist)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

class Ttl<T> {
  private readonly m = new Map<string, { v: T; at: number }>();
  constructor(
    private readonly ttl: number,
    private readonly now: () => number,
  ) {}
  get(k: string): T | undefined {
    const e = this.m.get(k);
    if (e === undefined) return undefined;
    if (this.now() - e.at > this.ttl) {
      this.m.delete(k);
      return undefined;
    }
    return e.v;
  }
  set(k: string, v: T): void {
    if (this.m.size >= CACHE_MAX) {
      const first = this.m.keys().next().value;
      if (first !== undefined) this.m.delete(first);
    }
    this.m.delete(k);
    this.m.set(k, { v, at: this.now() });
  }
}

export class ITunesSongIndex implements SongIndex {
  private readonly searches: Ttl<SongHit[]>;
  private readonly lookups: Ttl<SongHit | null>;
  private readonly country: string;

  constructor(options: { country?: string; fetchImpl?: FetchLike; now?: () => number } = {}) {
    const country = options.country?.trim().toLowerCase();
    this.country = country && /^[a-z]{2}$/.test(country) ? country : 'us';
    this.fetchImpl = options.fetchImpl ?? fetch;
    const now = options.now ?? Date.now;
    this.searches = new Ttl(SEARCH_TTL_MS, now);
    this.lookups = new Ttl(LOOKUP_TTL_MS, now);
  }

  private readonly fetchImpl: FetchLike;

  async search(term: string, limit: number): Promise<SongHit[]> {
    const cap = Math.min(25, Math.max(1, Math.floor(limit)));
    const q = term.trim().replace(/\s+/g, ' ');
    if (q === '') return [];
    const key = `${q.toLowerCase()}|${cap}`;
    const cached = this.searches.get(key);
    if (cached !== undefined) return cached.map((hit) => ({ ...hit }));
    const params = new URLSearchParams({
      term: q,
      media: 'music',
      entity: 'song',
      // Over-fetch so re-ranking and de-duplication still fill the gallery.
      limit: '50',
      country: this.country,
    });
    const payload = await this.request(`https://itunes.apple.com/search?${params.toString()}`);
    const raw: SongHit[] = [];
    for (const item of Array.isArray(payload.results) ? payload.results : []) {
      const hit = asSongHit(item);
      if (hit === null) continue;
      raw.push(hit);
      this.lookups.set(hit.id, hit);
    }
    const hits = rankSongHits(raw, q).slice(0, cap);
    this.searches.set(key, hits);
    return hits.map((hit) => ({ ...hit }));
  }

  async lookup(id: string): Promise<SongHit | null> {
    if (!/^\d{1,20}$/.test(id)) return null;
    const cached = this.lookups.get(id);
    if (cached !== undefined) return cached === null ? null : { ...cached };
    const params = new URLSearchParams({ id, entity: 'song', country: this.country });
    const payload = await this.request(`https://itunes.apple.com/lookup?${params.toString()}`);
    const hit = (Array.isArray(payload.results) ? payload.results : [])
      .map(asSongHit)
      .find((candidate): candidate is SongHit => candidate !== null && candidate.id === id);
    this.lookups.set(id, hit ?? null);
    return hit === undefined ? null : { ...hit };
  }

  private async request(url: string): Promise<{ results?: unknown }> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(8_000),
      });
    } catch (error) {
      throw new SongIndexError(error instanceof Error ? error.message : 'song index unreachable');
    }
    if (!response.ok) throw new SongIndexError(`song index returned ${response.status}`);
    try {
      // The endpoint answers text/javascript; the body is plain JSON.
      return JSON.parse(await response.text()) as { results?: unknown };
    } catch {
      throw new SongIndexError('song index returned invalid JSON');
    }
  }
}
