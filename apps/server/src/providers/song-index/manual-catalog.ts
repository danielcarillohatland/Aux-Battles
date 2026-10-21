/**
 * Zero-key song search for the manual playback mode (D-027): the song index
 * fills the player's search gallery, and every pick becomes a canonical manual
 * track the host opens in their own music service. No audio is ever fetched.
 */
import type { Track } from '@aux/shared';
import { MusicCatalogError, type ApprovedMusicCatalog } from '../music-provider.js';
import type { SongHit, SongIndex } from './itunes.js';

export function manualTrackId(title: string, artist: string): string {
  return `manual:${encodeURIComponent(title.toLowerCase())}:${encodeURIComponent(artist.toLowerCase())}`;
}

export function songHitAsManualTrack(hit: SongHit): Track {
  return {
    id: manualTrackId(hit.title, hit.artist),
    title: hit.title,
    artist: hit.artist,
    ...(hit.album === undefined ? {} : { album: hit.album }),
    ...(hit.durationMs === undefined ? {} : { durationMs: hit.durationMs }),
    // Search-index artwork is promotional content, not a game asset license.
    source: 'manual',
    ...(hit.storeUrl === undefined ? {} : { externalUrl: hit.storeUrl }),
  };
}

export class ManualSongCatalog implements ApprovedMusicCatalog {
  constructor(private readonly index: SongIndex) {}

  listTracks(): Track[] {
    return [];
  }

  async search(query: string, limit = 20): Promise<Track[]> {
    try {
      return (await this.index.search(query, limit)).map(songHitAsManualTrack);
    } catch (error) {
      throw new MusicCatalogError(
        'CATALOG_DOWN',
        error instanceof Error ? error.message : 'song search failed',
      );
    }
  }

  /** Manual picks are canonicalised by the rounds route from title + artist. */
  async getTrack(_id: string): Promise<Track> {
    throw new MusicCatalogError('TRACK_UNPLAYABLE');
  }

  playableTrack(_track: Track, _roomCode: string): Track | null {
    return null;
  }
}
