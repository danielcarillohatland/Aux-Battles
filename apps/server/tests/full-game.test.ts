import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/index.js';

describe('full manual-mode game', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    ({ app } = await buildServer({ LOG_LEVEL: 'error', AUX_DB_FILE: ':memory:' }));
  });
  afterAll(async () => app.close());

  it('runs create → submissions → judging → reveal → leaderboard → game over', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/v1/rooms', payload: {} });
    const host = created.json().data as { code: string; hostToken: string };
    const join = async (nickname: string) => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/rooms/${host.code}/join`,
        payload: { nickname },
      });
      return response.json().data as { playerToken: string };
    };
    const ada = await join('Ada');
    const bob = await join('Bob');
    const action = (name: string, payload: object = {}) =>
      app.inject({
        method: 'POST',
        url: `/api/v1/rooms/${host.code}/host/${name}`,
        headers: { authorization: `Bearer ${host.hostToken}` },
        payload,
      });

    expect((await action('start_game')).statusCode).toBe(200);
    await action('pick_category', { category: 'bank heist getaway' });
    await action('skip_phase');
    const submit = (token: string, id: string, title: string) =>
      app.inject({
        method: 'POST',
        url: `/api/v1/rounds/${host.code}:0/submissions`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          clientMsgId: `full-game-${id}`,
          track: { id, title, artist: 'Test Artist', durationMs: 180_000 },
        },
      });
    expect((await submit(ada.playerToken, 'track-ada', 'Fast Escape')).statusCode).toBe(200);
    expect((await submit(bob.playerToken, 'track-bob', 'Slow Ride')).statusCode).toBe(200);

    expect((await action('begin_playback')).statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await action('manual_next')).statusCode).toBe(200);
    expect((await action('manual_next')).statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const state = async () =>
      (await app.inject({ method: 'GET', url: `/api/v1/rooms/${host.code}/game-state` })).json()
        .data.state as string;
    expect(await state()).toBe('RESULTS');
    await action('advance_reveal', { final: false });
    await action('advance_reveal', { final: true });
    expect(await state()).toBe('LEADERBOARD');

    const snapshot = await app.inject({
      method: 'POST',
      url: '/api/v1/ws-ticket',
      headers: { authorization: `Bearer ${host.hostToken}` },
      payload: { code: host.code },
    });
    expect(snapshot.statusCode).toBe(200);
    expect((await action('finish_game')).statusCode).toBe(200);
    expect(await state()).toBe('GAME_OVER');
  });
});
