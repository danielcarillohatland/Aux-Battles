import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EncryptedSpotifyTokenStore,
  PkceStateStore,
  SpotifyOAuth,
  type SpotifyTokenStore,
  type StoredTokens,
} from '../src/providers/spotify/oauth.js';
import { spotifyRoute } from '../src/routes/spotify.js';
import { buildServer } from '../src/index.js';

class MemoryTokenStore implements SpotifyTokenStore {
  readonly values = new Map<string, StoredTokens>();

  async save(key: string, tokens: StoredTokens): Promise<void> {
    this.values.set(key, tokens);
  }

  async load(key: string): Promise<StoredTokens | null> {
    return this.values.get(key) ?? null;
  }

  async drop(key: string): Promise<void> {
    this.values.delete(key);
  }
}

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function oauthClient() {
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/api/token')) {
      return Response.json({
        access_token: 'access-secret',
        refresh_token: 'refresh-secret',
        expires_in: 3600,
        scope: 'user-read-email',
      });
    }
    if (url.endsWith('/v1/me')) {
      return Response.json({ id: 'spotify-user', display_name: 'Host DJ' });
    }
    return new Response('', { status: 404 });
  });
  return new SpotifyOAuth({
    clientId: 'client',
    clientSecret: 'secret',
    redirectUri: 'http://localhost/api/v1/spotify/callback',
    fetchImpl: fetchImpl as typeof fetch,
  });
}

describe('room-bound Spotify OAuth routes', () => {
  it('composition root accepts the real host token and rejects a player token', async () => {
    const { app } = await buildServer({
      LOG_LEVEL: 'error',
      AUX_DEV_MODE: '0',
      AUX_DB_FILE: ':memory:',
      SPOTIFY_CLIENT_ID: 'client',
      SPOTIFY_CLIENT_SECRET: 'secret',
      SPOTIFY_REDIRECT_URI: 'http://localhost/api/v1/spotify/callback',
    });
    const created = await app.inject({ method: 'POST', url: '/api/v1/rooms', payload: {} });
    const room = (
      created.json() as {
        data: { code: string; hostToken: string };
      }
    ).data;
    const joined = await app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${room.code}/join`,
      payload: { nickname: 'Guest' },
    });
    const playerToken = (joined.json() as { data: { playerToken: string } }).data.playerToken;

    const hostLogin = await app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${room.code}/spotify/login`,
      headers: { authorization: `Bearer ${room.hostToken}` },
    });
    expect(hostLogin.statusCode).toBe(200);
    expect((hostLogin.json() as { data: { authorizeUrl: string } }).data.authorizeUrl).toContain(
      'accounts.spotify.com/authorize',
    );

    const playerLogin = await app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${room.code}/spotify/login`,
      headers: { authorization: `Bearer ${playerToken}` },
    });
    expect(playerLogin.statusCode).toBe(403);
    await app.close();
  });

  it('requires the room host and stores the grant only for the initiating room', async () => {
    const app = Fastify();
    const tokens = new MemoryTokenStore();
    await app.register(
      spotifyRoute({
        oauth: oauthClient(),
        states: new PkceStateStore(),
        tokens,
        authorizeHost: (code, token) =>
          (code === 'ROOMA' && token === 'host-a') || (code === 'ROOMB' && token === 'host-b'),
      }),
      { prefix: '/api/v1' },
    );

    const denied = await app.inject({
      method: 'POST',
      url: '/api/v1/rooms/ROOMA/spotify/login',
      headers: { authorization: 'Bearer player-a' },
    });
    expect(denied.statusCode).toBe(403);

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/rooms/ROOMA/spotify/login',
      headers: { authorization: 'Bearer host-a' },
    });
    expect(login.statusCode).toBe(200);
    const authorizeUrl = (login.json() as { data: { authorizeUrl: string } }).data.authorizeUrl;
    const state = new URL(authorizeUrl).searchParams.get('state');
    expect(state).toBeTruthy();

    const callback = await app.inject({
      method: 'GET',
      url: `/api/v1/spotify/callback?code=grant&state=${encodeURIComponent(state!)}`,
    });
    expect(callback.statusCode).toBe(200);
    expect(tokens.values.has('room:ROOMA')).toBe(true);
    expect(tokens.values.has('room:ROOMB')).toBe(false);
    expect(callback.headers['set-cookie']).toContain('aux_host_session=ROOMA');

    const status = await app.inject({
      method: 'GET',
      url: '/api/v1/rooms/ROOMA/spotify/status',
      headers: { authorization: 'Bearer host-a' },
    });
    expect(status.json()).toMatchObject({ ok: true, data: { connected: true } });

    const replay = await app.inject({
      method: 'GET',
      url: `/api/v1/spotify/callback?code=grant&state=${encodeURIComponent(state!)}`,
    });
    expect(replay.statusCode).toBe(400);
    await app.close();
  });

  it('callback return URL honors frontendOrigin (dev) vs same-origin (prod)', async () => {
    // Dev configuration: hosts must land back on the live Vite frontend,
    // pinned to their room, instead of the API server's stale static bundle.
    const devApp = Fastify();
    const devTokens = new MemoryTokenStore();
    const states = new PkceStateStore();
    await devApp.register(
      spotifyRoute({
        oauth: oauthClient(),
        states,
        tokens: devTokens,
        frontendOrigin: 'https://dev.aux.example',
        authorizeHost: () => true,
      }),
      { prefix: '/api/v1' },
    );
    await devApp.ready();

    const login = await devApp.inject({
      method: 'POST',
      url: '/api/v1/rooms/ROOMA/spotify/login',
      headers: { authorization: 'Bearer host-a' },
    });
    const state = new URL(
      (login.json() as { data: { authorizeUrl: string } }).data.authorizeUrl,
    ).searchParams.get('state');
    const callback = await devApp.inject({
      method: 'GET',
      url: `/api/v1/spotify/callback?code=grant&state=${encodeURIComponent(state!)}`,
    });
    expect(callback.statusCode).toBe(200);
    expect(callback.body).toContain('https://dev.aux.example/host.html?room=ROOMA');
    await devApp.close();

    // Prod configuration: no frontendOrigin → same-origin relative path.
    const prodApp = Fastify();
    await prodApp.register(
      spotifyRoute({
        oauth: oauthClient(),
        states: new PkceStateStore(),
        tokens: new MemoryTokenStore(),
        authorizeHost: () => true,
      }),
      { prefix: '/api/v1' },
    );
    await prodApp.ready();

    const prodLogin = await prodApp.inject({
      method: 'POST',
      url: '/api/v1/rooms/ROOMA/spotify/login',
      headers: { authorization: 'Bearer host-a' },
    });
    const prodState = new URL(
      (prodLogin.json() as { data: { authorizeUrl: string } }).data.authorizeUrl,
    ).searchParams.get('state');
    const prodCallback = await prodApp.inject({
      method: 'GET',
      url: `/api/v1/spotify/callback?code=grant&state=${encodeURIComponent(prodState!)}`,
    });
    expect(prodCallback.body).toContain('href="/host.html"');
    expect(prodCallback.body).not.toContain('localhost');
    await prodApp.close();
  });
});

describe('encrypted Spotify token persistence', () => {
  it('reloads room tokens from ciphertext without persisting token plaintext', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aux-spotify-'));
    tempDirs.push(dir);
    const filePath = join(dir, 'tokens.json');
    const key = Buffer.alloc(32, 7);
    const refresh = vi.fn();
    const stored: StoredTokens = {
      accessToken: 'access-plaintext-must-not-leak',
      refreshToken: 'refresh-plaintext-must-not-leak',
      expiresAt: Date.now() + 3_600_000,
      scope: 'playback',
      spotifyUserId: 'spotify-user',
    };

    const first = new EncryptedSpotifyTokenStore({ key, oauth: { refresh }, filePath });
    await first.save('room:ABCDE', stored);

    const disk = readFileSync(filePath, 'utf8');
    expect(disk).not.toContain(stored.accessToken);
    expect(disk).not.toContain(stored.refreshToken!);
    expect(disk).not.toContain(stored.spotifyUserId!);

    const restarted = new EncryptedSpotifyTokenStore({ key, oauth: { refresh }, filePath });
    await expect(restarted.load('room:ABCDE')).resolves.toEqual(stored);
    expect(refresh).not.toHaveBeenCalled();
  });
});
