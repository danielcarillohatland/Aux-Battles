/** Project-owned, sample-free catalog backed by shared synthesizer recipes. */
import { AUX_ORIGINAL_TRACKS, type AuxOriginalDefinition, type Track } from '@aux/shared';
import { MusicCatalogError, type ApprovedMusicCatalog } from '../music-provider.js';

function normalize(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function editDistanceAtMostOne(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a === b) return true;
  let left = 0;
  let right = 0;
  let edits = 0;
  while (left < a.length && right < b.length) {
    if (a[left] === b[right]) {
      left += 1;
      right += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (a.length > b.length) left += 1;
    else if (b.length > a.length) right += 1;
    else {
      left += 1;
      right += 1;
    }
  }
  return edits + Number(left < a.length || right < b.length) <= 1;
}

function asTrack(definition: AuxOriginalDefinition): Track {
  return {
    id: definition.id,
    title: definition.title,
    artist: definition.artist,
    album: definition.album,
    durationMs: definition.durationMs,
    source: definition.source,
    description: definition.description,
    attribution: definition.attribution,
  };
}

export class OriginalCatalogProvider implements ApprovedMusicCatalog {
  listTracks(): Track[] {
    return AUX_ORIGINAL_TRACKS.map(asTrack);
  }

  async search(query: string, limit = 20): Promise<Track[]> {
    const tokens = normalize(query).split(' ').filter(Boolean);
    if (tokens.length === 0) return [];
    return AUX_ORIGINAL_TRACKS.filter((definition) => {
      const words = normalize(
        `${definition.title} ${definition.artist} ${definition.album ?? ''} ${definition.description} ${definition.tags.join(' ')}`,
      ).split(' ');
      return tokens.every((token) =>
        words.some(
          (word) =>
            word.startsWith(token) || (token.length >= 4 && editDistanceAtMostOne(token, word)),
        ),
      );
    })
      .slice(0, Math.max(1, Math.floor(limit)))
      .map(asTrack);
  }

  async getTrack(id: string): Promise<Track> {
    const definition = AUX_ORIGINAL_TRACKS.find((track) => track.id === id);
    if (definition === undefined) throw new MusicCatalogError('TRACK_UNPLAYABLE');
    return asTrack(definition);
  }

  playableTrack(submitted: Track, _roomCode: string): Track | null {
    const definition = AUX_ORIGINAL_TRACKS.find((track) => track.id === submitted.id);
    return definition === undefined ? null : asTrack(definition);
  }
}
