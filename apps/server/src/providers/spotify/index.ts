/**
 * SpotifyProvider — the real MusicProvider (TDD §7, L0 full API autoplay).
 *
 * Quarantined here by design: nothing outside providers/spotify/ may import
 * Spotify specifics. The engine depends on MusicProvider only; tests use
 * FakeProvider. The token dependency is an interface — S1 builds the real
 * encrypted store with proactive refresh; this file only consumes it.
 *
 * Round orchestration contract (§7): the engine preloads the entire round
 * queue in ONE startPlayback call (uris array), then verify-don't-drive polls
 * getPlaybackState() every 5–10 s instead of issuing per-track commands.
 */
import type { Track } from '@aux/shared';
import {
  MusicProviderError,
  type AuthResult,
  type Device,
  type MusicProvider,
  type StartPlaybackRequest,
} from '../music-provider.js';
import { SpotifyApiClient, type SpotifyTokenStore } from './playback.js';

export type { PlaybackState, SpotifyTokenStore } from './playback.js';

export class SpotifyProvider implements MusicProvider {
  private readonly api: SpotifyApiClient;

  constructor(deps: { tokenStore: SpotifyTokenStore; fetchImpl?: typeof fetch }) {
    this.api = new SpotifyApiClient({
      tokenStore: deps.tokenStore,
      ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    });
  }

  async search(query: string, limit = 10): Promise<Track[]> {
    return this.api.searchTracks(query, limit);
  }

  async getTrack(id: string): Promise<Track> {
    return this.api.getTrackById(id);
  }

  /**
   * L0 has no OAuth flow of its own — S1 owns Authorization Code + PKCE.
   * Here we verify the stored token actually works (cheap devices call) so
   * callers learn about expired tokens before a round starts. Premium status
   * is not exposed by /me (Feb 2026 Dev Mode), so deviceRequired is always
   * true for API playback and premium lapses surface as NOT_PREMIUM (403)
   * at playback time. Token failures propagate as MusicProviderError.
   */
  async authenticateHost(): Promise<AuthResult> {
    await this.api.listDevices();
    return { ok: true, deviceRequired: true };
  }

  /**
   * ONE call per round queue (§7): the whole round's uris go out in a single
   * PUT /v1/me/player/play. positionMs seeks into the first track when given.
   */
  async startPlayback(req: StartPlaybackRequest): Promise<void> {
    if (req.uris.length === 0) throw new MusicProviderError('TRACK_UNPLAYABLE');
    await this.api.startPlayback({
      uris: req.uris,
      ...(req.deviceId !== undefined ? { deviceId: req.deviceId } : {}),
      ...(req.positionMs !== undefined ? { positionMs: req.positionMs } : {}),
    });
  }

  pause(): Promise<void> {
    return this.api.pausePlayback();
  }

  resume(): Promise<void> {
    return this.api.resumePlayback();
  }

  next(): Promise<void> {
    return this.api.skipToNext();
  }

  /** The active device, or null when no player session exists yet. */
  async getActiveDevice(): Promise<Device | null> {
    const devices = await this.api.listDevices();
    return devices.find((d) => d.isActive) ?? null;
  }

  /**
   * Verify-only polling helper (§7 "verify-don't-drive", 5–10 s cadence).
   * Returns null while no device/session is active — callers treat that as
   * the start of the device-loss grace window, never as an immediate error.
   */
  getPlaybackState() {
    return this.api.getCurrentPlayback();
  }
}
