import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/index.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('process restart recovery', () => {
  it('rehydrates roster, tokens, FSM deadline, and submissions from SQLite', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aux-restart-'));
    dirs.push(dir);
    const db = join(dir, 'rooms.sqlite');
    const env = {
      LOG_LEVEL: 'error',
      AUX_DB_FILE: db,
      AUX_DEV_MODE: '0',
      AUX_ENABLE_ORIGINALS: '1',
    };

    const first = await buildServer(env);
    const created = await first.app.inject({ method: 'POST', url: '/api/v1/rooms', payload: {} });
    const room = created.json().data as { code: string; hostToken: string };
    const joined = await first.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${room.code}/join`,
      payload: { nickname: 'Restartable' },
    });
    const player = joined.json().data as { playerToken: string };
    await first.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${room.code}/join`,
      payload: { nickname: 'Still Here' },
    });
    const host = (action: string, payload: object = {}) =>
      first.app.inject({
        method: 'POST',
        url: `/api/v1/rooms/${room.code}/host/${action}`,
        headers: { authorization: `Bearer ${room.hostToken}` },
        payload,
      });
    await host('start_game');
    await host('pick_category', { category: 'restart songs' });
    await host('skip_phase');
    await first.app.inject({
      method: 'POST',
      url: `/api/v1/rounds/${room.code}:0/submissions`,
      headers: { authorization: `Bearer ${player.playerToken}` },
      payload: {
        clientMsgId: 'restart-msg-0001',
        track: {
          id: 'original:sunday-fast-forward',
          title: 'Ignored client title',
          artist: 'Ignored client artist',
        },
      },
    });
    await first.app.close();

    const second = await buildServer(env);
    const game = await second.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${room.code}/game-state`,
    });
    expect(game.json()).toMatchObject({
      ok: true,
      data: { state: 'SONG_SELECTION', roundIdx: 0 },
    });
    expect((game.json().data as { phaseEndsAt: number }).phaseEndsAt).toBeGreaterThan(Date.now());

    const ticket = await second.app.inject({
      method: 'POST',
      url: '/api/v1/ws-ticket',
      headers: { authorization: `Bearer ${player.playerToken}` },
      payload: { code: room.code },
    });
    expect(ticket.statusCode).toBe(200);
    expect(second.submissions.count(`${room.code}:0`)).toBe(1);
    await second.app.close();
  });
});
