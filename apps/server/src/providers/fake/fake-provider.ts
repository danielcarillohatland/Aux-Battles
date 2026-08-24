/**
 * FakeProvider (TDD §11): deterministic in-memory MusicProvider for tests and
 * local dev without Spotify. Implements the SAME interface — proof the seam holds.
 */
import type { Track } from '@aux/shared';
import {
  MusicProviderError,
  type AuthResult,
  type Device,
  type MusicProvider,
  type StartPlaybackRequest,
} from '../music-provider.js';

export class FakeProvider implements MusicProvider {
  readonly calls: string[] = [];
  playing: StartPlaybackRequest | null = null;
  paused = false;

  private readonly catalog: Track[] = [
    { id: 't1', title: 'Song 2', artist: 'Blur', durationMs: 262_000 },
    { id: 't2', title: 'Bohemian Rhapsody', artist: 'Queen', durationMs: 354_000 },
    { id: 't3', title: 'Sandstorm', artist: 'Darude', durationMs: 237_000 },
  ];

  async search(query: string, limit = 10): Promise<Track[]> {
    this.calls.push(`search:${query}`);
    const q = query.toLowerCase();
    return this.catalog
      .filter((t) => `${t.title} ${t.artist}`.toLowerCase().includes(q))
      .slice(0, limit);
  }

  async getTrack(id: string): Promise<Track> {
    const t = this.catalog.find((c) => c.id === id);
    if (!t) throw new MusicProviderError('TRACK_UNPLAYABLE');
    return t;
  }

  async authenticateHost(): Promise<AuthResult> {
    this.calls.push('authenticateHost');
    return { ok: true, deviceRequired: true };
  }

  async startPlayback(req: StartPlaybackRequest): Promise<void> {
    if (req.uris.length === 0) throw new MusicProviderError('TRACK_UNPLAYABLE');
    this.calls.push(`start:${req.uris.length}`);
    this.playing = req;
    this.paused = false;
  }

  async pause(): Promise<void> {
    this.calls.push('pause');
    this.paused = true;
  }

  async resume(): Promise<void> {
    this.calls.push('resume');
    this.paused = false;
  }

  async next(): Promise<void> {
    this.calls.push('next');
  }

  async getActiveDevice(): Promise<Device | null> {
    return { id: 'fake-device', name: 'Fake Speaker' };
  }
}
