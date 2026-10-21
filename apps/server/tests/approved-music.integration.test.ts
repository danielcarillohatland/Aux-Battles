import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/index.js';

describe('approved music integration', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    ({ app } = await buildServer({
      LOG_LEVEL: 'error',
      AUX_DB_FILE: ':memory:',
      AUX_ENABLE_ORIGINALS: '1',
      // Keep this suite offline: Deezer previews need an explicit opt-in here.
      AUX_DEEZER_PREVIEWS: '0',
      AUX_SONG_SEARCH: '0',
      // A real key in the developer's .env must not pull live YouTube into this suite.
      AUX_YOUTUBE_API_KEY: '',
    }));
  });
  afterAll(async () => app.close());

  it('has no streaming-account authorization route', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/rooms/ABCDE/spotify/status',
    });
    expect(response.statusCode).toBe(404);
  });

  it('serves the new AUX original through authenticated player search', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/v1/rooms', payload: {} });
    const room = created.json().data as { code: string };
    const joined = await app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${room.code}/join`,
      payload: { nickname: 'Listener' },
    });
    const player = joined.json().data as { playerToken: string };
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/search?q=midnight%20pancakes',
      headers: { authorization: `Bearer ${player.playerToken}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      data: {
        tracks: [
          {
            id: 'original:midnight-pancakes',
            title: 'Midnight Pancakes',
            source: 'original',
          },
        ],
      },
    });
  });
});
