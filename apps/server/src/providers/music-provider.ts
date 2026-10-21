/** Approved music-catalog seam. Provider audio is rendered only by its official SDK. */
import type { Track } from '@aux/shared';

export class MusicCatalogError extends Error {
  constructor(
    public readonly code: 'TRACK_UNPLAYABLE' | 'CATALOG_DOWN',
    public readonly detail?: string,
  ) {
    super(`catalog error: ${code}${detail ? ` (${detail})` : ''}`);
    this.name = 'MusicCatalogError';
  }
}

export interface ApprovedMusicCatalog {
  search(query: string, limit?: number): Promise<Track[]>;
  getTrack(id: string): Promise<Track>;
  listTracks(): Track[];
  /**
   * Host-playable version of a submitted track, or null when this catalog does
   * not own it. The input is the server-canonicalized copy from the submission
   * store, so providers without a durable local index (streaming APIs) can
   * trust its metadata after a restart and only attach room-bound playback data.
   */
  playableTrack(track: Track, roomCode: string): Track | null;
}

/** Combines configured catalogs while keeping provider details out of game logic. */
export class CombinedMusicCatalog implements ApprovedMusicCatalog {
  constructor(private readonly catalogs: readonly ApprovedMusicCatalog[]) {}

  listTracks(): Track[] {
    const seen = new Set<string>();
    const tracks: Track[] = [];
    for (const catalog of this.catalogs) {
      for (const track of catalog.listTracks()) {
        if (seen.has(track.id)) continue;
        seen.add(track.id);
        tracks.push({ ...track });
      }
    }
    return tracks;
  }

  async search(query: string, limit = 20): Promise<Track[]> {
    if (this.catalogs.length === 0) {
      throw new MusicCatalogError('CATALOG_DOWN', 'no music catalog is configured');
    }
    const cap = Math.max(1, Math.floor(limit));
    // One flaky remote catalog must not blank out results from the others;
    // only fail the search when every configured catalog failed.
    const settled = await Promise.allSettled(
      this.catalogs.map((catalog) => catalog.search(query, cap)),
    );
    const groups = settled.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    );
    if (groups.length === 0) {
      const first = settled[0];
      throw first !== undefined && first.status === 'rejected' && first.reason instanceof Error
        ? first.reason
        : new MusicCatalogError('CATALOG_DOWN', 'every music catalog failed');
    }
    const seen = new Set<string>();
    const tracks: Track[] = [];
    for (const group of groups) {
      for (const track of group) {
        if (seen.has(track.id)) continue;
        seen.add(track.id);
        tracks.push(track);
        if (tracks.length >= cap) return tracks;
      }
    }
    return tracks;
  }

  async getTrack(id: string): Promise<Track> {
    for (const catalog of this.catalogs) {
      try {
        return await catalog.getTrack(id);
      } catch (error) {
        if (!(error instanceof MusicCatalogError) || error.code !== 'TRACK_UNPLAYABLE') throw error;
      }
    }
    throw new MusicCatalogError('TRACK_UNPLAYABLE', 'track is not in an approved catalog');
  }

  playableTrack(track: Track, roomCode: string): Track | null {
    for (const catalog of this.catalogs) {
      const playable = catalog.playableTrack(track, roomCode);
      if (playable !== null) return playable;
    }
    return null;
  }
}
