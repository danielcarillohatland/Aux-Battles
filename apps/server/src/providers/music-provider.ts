/**
 * MusicProvider seam (TDD §7). The game engine imports ONLY this interface.
 * Spotify-specific code lives exclusively in providers/spotify/ (owner condition #5).
 */
import type { Track } from '@aux/shared';

export type ProviderError =
  | 'DEVICE_OFFLINE'
  | 'NOT_PREMIUM'
  | 'RATE_LIMITED'
  | 'TOKEN_EXPIRED'
  | 'TRACK_UNPLAYABLE'
  | 'NO_ACTIVE_DEVICE'
  | 'PROVIDER_DOWN';

export class MusicProviderError extends Error {
  constructor(
    public readonly code: ProviderError,
    public readonly retryAfterSecs?: number,
  ) {
    super(`provider error: ${code}`);
  }
}

export interface StartPlaybackRequest {
  uris: string[];
  deviceId?: string;
  positionMs?: number;
}

export interface Device {
  id: string;
  name: string;
}

export interface AuthResult {
  ok: boolean;
  deviceRequired: boolean;
}

export interface MusicProvider {
  search(query: string, limit?: number): Promise<Track[]>;
  getTrack(id: string): Promise<Track>;
  authenticateHost(): Promise<AuthResult>;
  startPlayback(req: StartPlaybackRequest): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  next(): Promise<void>;
  getActiveDevice(): Promise<Device | null>;
}
