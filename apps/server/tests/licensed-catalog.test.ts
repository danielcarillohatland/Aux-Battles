import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { LicensedCatalogProvider } from '../src/providers/licensed-catalog/index.js';
import { licensedMusicRoute } from '../src/routes/licensed-music.js';

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture(overrides: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aux-licensed-'));
  cleanup.push(root);
  writeFileSync(join(root, 'song.mp3'), Buffer.from('fake-audio'));
  writeFileSync(join(root, 'license.pdf'), Buffer.from('license evidence'));
  const manifest = {
    version: 1,
    licensee: 'AUX BATTLES AS',
    tracks: [
      {
        id: 'party-one',
        title: 'Party One',
        artist: 'Cleared Artist',
        description: 'Bright celebratory pop with a confident lift.',
        durationMs: 90_000,
        audioFile: 'song.mp3',
        credit: 'Party One — Cleared Artist, licensed for AUX BATTLES',
        license: {
          source: 'Jamendo Licensing',
          reference: 'ORDER-123',
          evidenceFile: 'license.pdf',
          territories: 'worldwide',
          gameAndAppUse: true,
          appStoreDistribution: true,
          commercialUse: true,
        },
        ...overrides,
      },
    ],
  };
  const manifestPath = join(root, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return { root, manifestPath };
}

describe('LicensedCatalogProvider', () => {
  it('searches cleared metadata and issues room-bound playback endpoints', async () => {
    const { manifestPath } = fixture();
    const catalog = new LicensedCatalogProvider(manifestPath);

    await expect(catalog.search('cleared party')).resolves.toMatchObject([
      { id: 'licensed:party-one', source: 'licensed', title: 'Party One' },
    ]);
    expect(
      catalog.playableTrack({ id: 'licensed:party-one', title: 'x', artist: 'y' }, 'A7X2M'),
    ).toMatchObject({
      playbackUrl: '/api/v1/rooms/A7X2M/licensed-music/licensed%3Aparty-one/audio',
      attribution: 'Party One — Cleared Artist, licensed for AUX BATTLES',
    });
    expect(catalog.audioAsset('licensed:party-one')).toMatchObject({
      mimeType: 'audio/mpeg',
      size: 10,
    });
  });

  it('fails closed when a required app-store grant is absent', () => {
    const { manifestPath } = fixture({
      license: {
        source: 'Unknown',
        reference: 'NO-GAME-RIGHTS',
        evidenceFile: 'license.pdf',
        territories: 'worldwide',
        gameAndAppUse: true,
        appStoreDistribution: false,
        commercialUse: true,
      },
    });
    expect(() => new LicensedCatalogProvider(manifestPath)).toThrow(/appStoreDistribution/);
  });

  it('fails closed when license evidence is missing', () => {
    const { manifestPath } = fixture({
      license: {
        source: 'Jamendo Licensing',
        reference: 'ORDER-123',
        evidenceFile: 'missing.pdf',
        territories: 'worldwide',
        gameAndAppUse: true,
        appStoreDistribution: true,
        commercialUse: true,
      },
    });
    expect(() => new LicensedCatalogProvider(manifestPath)).toThrow(/evidenceFile does not exist/);
  });
});

describe('licensed audio route', () => {
  it('requires host auth and serves media with no-store headers', async () => {
    const { manifestPath } = fixture();
    const app = Fastify();
    await app.register(
      licensedMusicRoute({
        catalog: new LicensedCatalogProvider(manifestPath),
        authorizeHost: (code, token) => code === 'A7X2M' && token === 'host-token',
      }),
    );

    const denied = await app.inject({
      method: 'GET',
      url: '/rooms/A7X2M/licensed-music/licensed%3Aparty-one/audio',
    });
    expect(denied.statusCode).toBe(403);

    const played = await app.inject({
      method: 'GET',
      url: '/rooms/A7X2M/licensed-music/licensed%3Aparty-one/audio',
      headers: { authorization: 'Bearer host-token' },
    });
    expect(played.statusCode).toBe(200);
    expect(played.headers['content-type']).toContain('audio/mpeg');
    expect(played.headers['cache-control']).toContain('no-store');
    expect(played.body).toBe('fake-audio');
    await app.close();
  });
});
