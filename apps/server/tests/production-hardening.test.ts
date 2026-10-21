/**
 * Production hardening regressions: proxy trust, HTTP headers and error
 * envelopes, the authenticated polling snapshot, room lifecycle cleanup, and
 * the report/hide moderation flow.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { SnapshotSchema } from '@aux/shared';
import { buildServer, trustedProxyHops } from '../src/index.js';
import { RoomManager } from '../src/core/room-manager.js';

const servers: Awaited<ReturnType<typeof buildServer>>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(({ app }) => app.close()));
});

async function setup(env: NodeJS.ProcessEnv = {}) {
  const server = await buildServer({
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    AUX_SONG_SEARCH: '0',
    ...env,
  });
  servers.push(server);
  return server;
}

describe('proxy trust', () => {
  it('parses hop counts and rejects ambiguous values', () => {
    expect(trustedProxyHops(undefined)).toBe(false);
    expect(trustedProxyHops('0')).toBe(false);
    const trust = trustedProxyHops('1');
    expect(trust && trust('10.0.0.1', 0)).toBe(true);
    expect(trust && trust('10.0.0.1', 1)).toBe(false);
    expect(() => trustedProxyHops('true')).toThrow('hops');
  });

  it('ignores client-supplied X-Forwarded-For entries beyond the trusted hop', async () => {
    const { app } = await setup({ AUX_TRUST_PROXY: '1' });
    const seen: string[] = [];
    app.get('/ip-probe', async (request) => {
      seen.push(request.ip);
      return { ok: true };
    });
    await app.inject({
      url: '/ip-probe',
      remoteAddress: '10.0.0.9',
      headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.7' },
    });
    // Fly appends the real client last; the spoofed left-most entry is ignored.
    expect(seen).toEqual(['203.0.113.7']);
  });
});

describe('HTTP hardening', () => {
  it('sends baseline security headers and never caches API responses', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'POST', url: '/api/v1/rooms', payload: {} });
    expect(res.statusCode).toBe(201);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('wraps unexpected failures in the shared envelope without internals', async () => {
    const { app } = await setup();
    app.log.level = 'fatal'; // the logged stack is expected here
    app.get('/boom', async () => {
      throw new Error('upstream said: secret-token-123');
    });
    const res = await app.inject({ url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
    expect(res.body).not.toContain('secret-token-123');
  });

  it('serves public app configuration with only allowlisted, validated fields', async () => {
    const { app } = await setup({
      AUX_PUBLISHER_NAME: 'AUX Studio',
      AUX_PRIVACY_URL: 'https://example.com/privacy',
    });
    const res = await app.inject({ url: '/api/v1/app-config' });
    expect(res.json()).toEqual({
      ok: true,
      data: {
        publisherName: 'AUX Studio',
        privacyUrl: 'https://example.com/privacy',
        termsUrl: null,
        supportUrl: null,
        reportsAvailable: true,
      },
    });
    await expect(setup({ AUX_SUPPORT_URL: 'http://insecure.example' })).rejects.toThrow('HTTPS');
    const bundled = await setup({ AUX_PUBLIC_ORIGIN: 'https://aux.example.com' });
    expect((await bundled.app.inject({ url: '/api/v1/app-config' })).json().data.privacyUrl).toBe(
      'https://aux.example.com/privacy.html',
    );
  });
});

describe('REST polling fallback', () => {
  it('returns the member’s full live snapshot with a token and the lobby summary without', async () => {
    const server = await setup();
    const host = server.roomManager.createRoom();
    const player = server.roomManager.joinRoom(host.code, 'Riley');
    const authed = await server.app.inject({
      url: `/api/v1/rooms/${host.code}/snapshot`,
      headers: { authorization: `Bearer ${player.playerToken}` },
    });
    expect(authed.statusCode).toBe(200);
    const parsed = SnapshotSchema.safeParse(authed.json().data);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.you).toMatchObject({ role: 'player', nickname: 'Riley' });

    const forged = await server.app.inject({
      url: `/api/v1/rooms/${host.code}/snapshot`,
      headers: { authorization: 'Bearer not-a-real-token' },
    });
    expect(forged.statusCode).toBe(401);

    const anonymous = await server.app.inject({ url: `/api/v1/rooms/${host.code}/snapshot` });
    expect(anonymous.json().data).not.toHaveProperty('you');
  });
});

describe('room lifecycle', () => {
  it('restored players stay offline until they redial', () => {
    const manager = new RoomManager();
    const host = manager.createRoom();
    manager.joinRoom(host.code, 'Riley');
    const saved = manager.serialize(host.code)!;
    const restored = new RoomManager();
    restored.hydrate(host.code, saved);
    expect([...restored.get(host.code)!.players.values()].every((p) => !p.connected)).toBe(true);
  });

  it('replaces a disconnected same-name ghost in the lobby instead of filling seats', () => {
    const manager = new RoomManager();
    manager.isLobby = () => true;
    const host = manager.createRoom();
    const first = manager.joinRoom(host.code, 'Riley');
    manager.get(host.code)!.players.get(first.playerId)!.connected = false;
    const second = manager.joinRoom(host.code, 'riley');
    const players = manager.get(host.code)!.players;
    expect(players.has(first.playerId)).toBe(false);
    expect(players.has(second.playerId)).toBe(true);
    expect(players.size).toBe(2);
  });

  it('keeps a disconnected player’s seat once a game is under way', () => {
    const manager = new RoomManager();
    manager.isLobby = () => false;
    const host = manager.createRoom();
    const first = manager.joinRoom(host.code, 'Riley');
    manager.get(host.code)!.players.get(first.playerId)!.connected = false;
    manager.joinRoom(host.code, 'Riley');
    expect(manager.get(host.code)!.players.has(first.playerId)).toBe(true);
  });
});

describe('reports and viewer-local hiding', () => {
  it('stores a report idempotently and hides the target only for the reporter', async () => {
    const server = await setup();
    const host = server.roomManager.createRoom();
    const reporter = server.roomManager.joinRoom(host.code, 'Riley');
    const target = server.roomManager.joinRoom(host.code, 'Morgan');
    const bystander = server.roomManager.joinRoom(host.code, 'Sam');
    const body = {
      clientReportId: '1b4e28ba-2fa1-4d3b-9a5c-6f1d2e3c4b5a',
      kind: 'nickname',
      targetNickname: 'Morgan',
      details: 'Offensive name',
      alsoBlock: true,
    };
    const report = () =>
      server.app.inject({
        method: 'POST',
        url: `/api/v1/rooms/${host.code}/reports`,
        headers: { authorization: `Bearer ${reporter.playerToken}` },
        payload: body,
      });
    const first = await report();
    expect(first.statusCode).toBe(201);
    const replay = await report();
    expect(replay.statusCode).toBe(200);
    expect(replay.json().data.reportId).toBe(first.json().data.reportId);

    const names = async (token: string) =>
      (
        await server.app.inject({
          url: `/api/v1/rooms/${host.code}/snapshot`,
          headers: { authorization: `Bearer ${token}` },
        })
      )
        .json()
        .data.players.map((player: { nickname: string }) => player.nickname);
    expect(await names(reporter.playerToken)).toEqual(['Riley', 'Hidden player', 'Sam']);
    expect(await names(bystander.playerToken)).toEqual(['Riley', 'Morgan', 'Sam']);
    expect(await names(target.playerToken)).toContain('Riley');

    const anonymous = await server.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${host.code}/reports`,
      payload: { ...body, clientReportId: '2b4e28ba-2fa1-4d3b-9a5c-6f1d2e3c4b5a' },
    });
    expect(anonymous.statusCode).toBe(401);
  });
});
