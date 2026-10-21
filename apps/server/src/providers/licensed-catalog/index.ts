/**
 * Rights-cleared catalog provider.
 *
 * Unlike a streaming-service integration, this provider serves only audio the
 * publisher has explicitly attested is licensed for commercial games and app
 * store distribution. Startup fails closed when media or license evidence is
 * missing, expired, outside the configured root, or lacks the required grants.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import type { Track } from '@aux/shared';
import { MusicCatalogError, type ApprovedMusicCatalog } from '../music-provider.js';

interface LicenseGrant {
  source: string;
  reference: string;
  evidenceFile: string;
  territories: string;
  gameAndAppUse: true;
  appStoreDistribution: true;
  commercialUse: true;
  expiresAt?: string;
}

interface ManifestTrack {
  id: string;
  title: string;
  artist: string;
  album?: string;
  description: string;
  durationMs: number;
  audioFile: string;
  credit: string;
  license: LicenseGrant;
}

interface LicensedCatalogManifest {
  version: 1;
  licensee: string;
  tracks: ManifestTrack[];
}

export interface LicensedAudioAsset {
  path: string;
  mimeType: string;
  size: number;
}

interface CatalogEntry {
  track: Track;
  audio: LicensedAudioAsset;
}

const AUDIO_MIME: Readonly<Record<string, string>> = {
  '.aac': 'audio/aac',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
};

function requiredString(value: unknown, field: string, max = 160): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) {
    throw new Error(`licensed catalog: ${field} must be a non-empty string (max ${max})`);
  }
  return value.trim();
}

function safeFile(root: string, candidate: unknown, field: string): string {
  const fragment = requiredString(candidate, field, 500);
  if (isAbsolute(fragment)) throw new Error(`licensed catalog: ${field} must be relative`);
  const full = resolve(root, fragment);
  const rel = relative(root, full);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`licensed catalog: ${field} escapes the catalog root`);
  }
  if (!existsSync(full) || !statSync(full).isFile()) {
    throw new Error(`licensed catalog: ${field} does not exist (${fragment})`);
  }
  return full;
}

function parseManifest(raw: unknown, root: string): LicensedCatalogManifest {
  if (typeof raw !== 'object' || raw === null) throw new Error('licensed catalog: bad manifest');
  const input = raw as Record<string, unknown>;
  if (input.version !== 1) throw new Error('licensed catalog: unsupported manifest version');
  const licensee = requiredString(input.licensee, 'licensee');
  if (!Array.isArray(input.tracks) || input.tracks.length === 0) {
    throw new Error('licensed catalog: at least one track is required');
  }
  const ids = new Set<string>();
  const tracks = input.tracks.map((value, index): ManifestTrack => {
    if (typeof value !== 'object' || value === null) {
      throw new Error(`licensed catalog: tracks[${index}] must be an object`);
    }
    const item = value as Record<string, unknown>;
    const bareId = requiredString(item.id, `tracks[${index}].id`, 80);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(bareId)) {
      throw new Error(`licensed catalog: tracks[${index}].id contains unsafe characters`);
    }
    if (ids.has(bareId)) throw new Error(`licensed catalog: duplicate track id ${bareId}`);
    ids.add(bareId);
    const durationMs = Number(item.durationMs);
    if (!Number.isInteger(durationMs) || durationMs <= 0) {
      throw new Error(`licensed catalog: tracks[${index}].durationMs must be positive`);
    }
    const rights = item.license;
    if (typeof rights !== 'object' || rights === null) {
      throw new Error(`licensed catalog: tracks[${index}].license is required`);
    }
    const license = rights as Record<string, unknown>;
    for (const grant of ['gameAndAppUse', 'appStoreDistribution', 'commercialUse'] as const) {
      if (license[grant] !== true) {
        throw new Error(`licensed catalog: tracks[${index}].license.${grant} must be true`);
      }
    }
    const expiresAt =
      license.expiresAt === undefined
        ? undefined
        : requiredString(license.expiresAt, `tracks[${index}].license.expiresAt`, 40);
    if (expiresAt !== undefined) {
      const expiry = Date.parse(expiresAt);
      if (!Number.isFinite(expiry) || expiry <= Date.now()) {
        throw new Error(`licensed catalog: tracks[${index}] license is expired or invalid`);
      }
    }
    // Resolve both files during validation. The returned manifest remains
    // serializable; the provider resolves them once more when building entries.
    safeFile(root, item.audioFile, `tracks[${index}].audioFile`);
    safeFile(root, license.evidenceFile, `tracks[${index}].license.evidenceFile`);
    return {
      id: bareId,
      title: requiredString(item.title, `tracks[${index}].title`, 80),
      artist: requiredString(item.artist, `tracks[${index}].artist`, 80),
      ...(item.album === undefined
        ? {}
        : { album: requiredString(item.album, `tracks[${index}].album`, 80) }),
      description: requiredString(item.description, `tracks[${index}].description`, 240),
      durationMs,
      audioFile: requiredString(item.audioFile, `tracks[${index}].audioFile`, 500),
      credit: requiredString(item.credit, `tracks[${index}].credit`, 160),
      license: {
        source: requiredString(license.source, `tracks[${index}].license.source`, 120),
        reference: requiredString(license.reference, `tracks[${index}].license.reference`, 160),
        evidenceFile: requiredString(
          license.evidenceFile,
          `tracks[${index}].license.evidenceFile`,
          500,
        ),
        territories: requiredString(
          license.territories,
          `tracks[${index}].license.territories`,
          120,
        ),
        gameAndAppUse: true,
        appStoreDistribution: true,
        commercialUse: true,
        ...(expiresAt === undefined ? {} : { expiresAt }),
      },
    };
  });
  return { version: 1, licensee, tracks };
}

function normalize(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export class LicensedCatalogProvider implements ApprovedMusicCatalog {
  private readonly entries = new Map<string, CatalogEntry>();

  constructor(manifestPath: string, catalogRoot?: string) {
    const absoluteManifest = resolve(manifestPath);
    const root = resolve(catalogRoot ?? dirname(absoluteManifest));
    const manifest = parseManifest(JSON.parse(readFileSync(absoluteManifest, 'utf8')), root);
    for (const item of manifest.tracks) {
      const id = `licensed:${item.id}`;
      const audioPath = safeFile(root, item.audioFile, `${item.id}.audioFile`);
      const extension = extname(audioPath).toLowerCase();
      const mimeType = AUDIO_MIME[extension];
      if (mimeType === undefined) {
        throw new Error(`licensed catalog: ${item.audioFile} has an unsupported audio format`);
      }
      // Re-check evidence here so the constructed provider never contains an
      // entry without its store-review paper trail.
      safeFile(root, item.license.evidenceFile, `${item.id}.license.evidenceFile`);
      this.entries.set(id, {
        track: {
          id,
          title: item.title,
          artist: item.artist,
          ...(item.album === undefined ? {} : { album: item.album }),
          durationMs: item.durationMs,
          source: 'licensed',
          description: item.description,
          attribution: item.credit,
        },
        audio: { path: audioPath, mimeType, size: statSync(audioPath).size },
      });
    }
  }

  static fromEnv(env: NodeJS.ProcessEnv): LicensedCatalogProvider | null {
    const manifest = env.AUX_LICENSED_MUSIC_MANIFEST?.trim();
    if (!manifest) return null;
    const root = env.AUX_LICENSED_MUSIC_ROOT?.trim();
    return new LicensedCatalogProvider(manifest, root || undefined);
  }

  listTracks(): Track[] {
    return [...this.entries.values()].map(({ track }) => ({ ...track }));
  }

  audioAsset(id: string): LicensedAudioAsset | null {
    const asset = this.entries.get(id)?.audio;
    return asset === undefined ? null : { ...asset };
  }

  playableTrack(submitted: Track, roomCode: string): Track | null {
    const track = this.entries.get(submitted.id)?.track;
    if (track === undefined) return null;
    return {
      ...track,
      playbackUrl: `/api/v1/rooms/${encodeURIComponent(roomCode)}/licensed-music/${encodeURIComponent(track.id)}/audio`,
    };
  }

  async search(query: string, limit = 20): Promise<Track[]> {
    const tokens = normalize(query).split(' ').filter(Boolean);
    if (tokens.length === 0) return [];
    return this.listTracks()
      .filter((track) => {
        const haystack = normalize(`${track.title} ${track.artist} ${track.album ?? ''}`);
        return tokens.every((token) => haystack.includes(token));
      })
      .slice(0, Math.max(1, Math.floor(limit)));
  }

  async getTrack(id: string): Promise<Track> {
    const track = this.entries.get(id)?.track;
    if (track === undefined) throw new MusicCatalogError('TRACK_UNPLAYABLE');
    return { ...track };
  }
}
