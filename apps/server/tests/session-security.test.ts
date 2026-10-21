import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../src/index.js';
import { loadConfig } from '../src/core/config.js';
import { verifyToken } from '../src/core/tokens.js';
import type { SerializedRoom } from '../src/core/room-manager.js';

const dirs: string[] = [];
const servers: Awaited<ReturnType<typeof buildServer>>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(({ app }) => app.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function setup(env: NodeJS.ProcessEnv = {}) {
  const server = await buildServer({
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    AUX_SONG_SEARCH: '0',
    ...env,
  });
  servers.push(server);
  const host = server.roomManager.createRoom();
  const player = server.roomManager.joinRoom(host.code, 'Riley');
  const room = server.roomManager.get(host.code)!;
  const reclaim = (nickname: string, token?: string) =>
    server.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${host.code}/reclaim`,
      payload: { nickname },
      ...(token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } }),
    });
  return { ...server, host, player, room, reclaim };
}

describe('session ownership during reclaim', () => {
  it('rejects unauthenticated takeover of a disconnected host or player', async () => {
    const { host, player, room, reclaim } = await setup();
    room.players.get(host.playerId)!.connected = false;
    room.players.get(player.playerId)!.connected = false;

    for (const nickname of ['Host', 'Riley']) {
      const response = await reclaim(nickname);
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe('NOT_AUTHENTICATED');
    }
    expect(verifyToken(host.hostToken, room.players.get(host.playerId)!.tokenHash)).toBe(true);
    expect(verifyToken(player.playerToken, room.players.get(player.playerId)!.tokenHash)).toBe(
      true,
    );
  });

  it('rejects another member targeting the disconnected host nickname', async () => {
    const { host, player, room, reclaim } = await setup();
    room.players.get(host.playerId)!.connected = false;
    const response = await reclaim('Host', player.playerToken);
    expect(response.statusCode).toBe(403);
    expect(verifyToken(host.hostToken, room.players.get(host.playerId)!.tokenHash)).toBe(true);
  });

  it('rotates, persists and broadcasts the owning player session and rejects the old token', async () => {
    const { app, host, player, room, reclaim, store, wsHub } = await setup();
    room.players.get(player.playerId)!.connected = false;
    const broadcast = vi.spyOn(wsHub, 'broadcastStateChange');
    const response = await reclaim('rIlEy', player.playerToken);
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const renewed = response.json().data as {
      playerToken: string;
      playerId: string;
      nickname: string;
    };
    expect(renewed).toMatchObject({ playerId: player.playerId, nickname: 'Riley' });
    expect(renewed.playerToken).not.toBe(player.playerToken);
    const checkpoint = store.get(host.code)!.state as { room: SerializedRoom };
    const persisted = checkpoint.room.players.find(([id]) => id === player.playerId)![1];
    expect(verifyToken(renewed.playerToken, persisted.tokenHash)).toBe(true);
    expect(verifyToken(player.playerToken, persisted.tokenHash)).toBe(false);
    expect(broadcast).toHaveBeenCalledWith(host.code);

    for (const [token, expectedStatus] of [
      [player.playerToken, 401],
      [renewed.playerToken, 200],
    ] as const) {
      const ticket = await app.inject({
        method: 'POST',
        url: '/api/v1/ws-ticket',
        headers: { authorization: `Bearer ${token}` },
        payload: { code: host.code },
      });
      expect(ticket.statusCode).toBe(expectedStatus);
    }
  });

  it('preserves host authorization after the host rotates their own session', async () => {
    const { app, host, room, reclaim } = await setup();
    room.players.get(host.playerId)!.connected = false;
    const response = await reclaim('Host', host.hostToken);
    expect(response.statusCode).toBe(200);
    const { playerToken } = response.json().data as { playerToken: string };
    const started = await app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${host.code}/host/start_game`,
      headers: { authorization: `Bearer ${playerToken}` },
    });
    expect(started.statusCode).toBe(200);
  });

  it('allows only one concurrent rotation using the same token', async () => {
    const { player, room, reclaim } = await setup();
    room.players.get(player.playerId)!.connected = false;
    const results = await Promise.all([
      reclaim('Riley', player.playerToken),
      reclaim('Riley', player.playerToken),
    ]);
    expect(results.map((result) => result.statusCode).sort()).toEqual([200, 401]);
  });

  it('does not rotate a still-connected identity', async () => {
    const { player, room, reclaim } = await setup();
    const response = await reclaim('Riley', player.playerToken);
    expect(response.statusCode).toBe(409);
    expect(verifyToken(player.playerToken, room.players.get(player.playerId)!.tokenHash)).toBe(
      true,
    );
  });

  it('persists kicked membership removal so a restart cannot restore the token', async () => {
    const { app, host, player, store } = await setup();
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${host.code}/kick`,
      headers: { authorization: `Bearer ${host.hostToken}` },
      payload: { playerId: player.playerId },
    });
    expect(response.statusCode).toBe(200);
    const checkpoint = store.get(host.code)!.state as { room: SerializedRoom };
    expect(checkpoint.room.players.map(([id]) => id)).not.toContain(player.playerId);
    const ticket = await app.inject({
      method: 'POST',
      url: '/api/v1/ws-ticket',
      headers: { authorization: `Bearer ${player.playerToken}` },
      payload: { code: host.code },
    });
    expect(ticket.statusCode).toBe(401);
  });
});

describe('production debug isolation', () => {
  it('forces dev mode off in production even if the debug flag is set', () => {
    expect(loadConfig({ NODE_ENV: 'production', AUX_DEV_MODE: '1' }).devMode).toBe(false);
    expect(loadConfig({ NODE_ENV: 'development', AUX_DEV_MODE: '1' }).devMode).toBe(true);
  });

  it('never registers the debug state endpoint in production', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aux-production-test-'));
    dirs.push(dir);
    const { app } = await setup({
      NODE_ENV: 'production',
      AUX_DEV_MODE: '1',
      AUX_DB_FILE: join(dir, 'rooms.db'),
    });
    expect((await app.inject({ method: 'GET', url: '/dev/state' })).statusCode).toBe(404);
  });
});
