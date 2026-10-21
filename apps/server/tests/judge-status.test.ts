import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { judgeRoute } from '../src/routes/judge.js';

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function setup(
  configured: boolean,
  getStatus?: Parameters<typeof judgeRoute>[0]['getStatus'],
) {
  const app = Fastify();
  apps.push(app);
  await app.register(
    judgeRoute({
      configured,
      getStatus,
      authorizeHost: (code, token) => code === 'ABCDE' && token === 'host-secret',
    }),
    { prefix: '/api/v1' },
  );
  return {
    app,
    status: () =>
      app.inject({
        method: 'GET',
        url: '/api/v1/rooms/ABCDE/judge/status',
        headers: { authorization: 'Bearer host-secret' },
      }),
  };
}

describe('host judge diagnostics', () => {
  it('requires the room host and does not cache diagnostic responses', async () => {
    const { app, status } = await setup(false);
    expect((await app.inject('/api/v1/rooms/ABCDE/judge/status')).statusCode).toBe(403);
    expect(
      (
        await app.inject({
          url: '/api/v1/rooms/ABCDE/judge/status',
          headers: { authorization: 'Bearer player-secret' },
        })
      ).statusCode,
    ).toBe(403);
    const response = await status();
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.json().data.state).toBe('offline');
  });

  it('distinguishes configured credentials from a successful response', async () => {
    const health: { lastSuccessAt?: string } = {};
    const { status } = await setup(true, () => ({ requests: 0, maxRequests: 100, ...health }));
    expect((await status()).json().data.state).toBe('configured');
    health.lastSuccessAt = new Date().toISOString();
    expect((await status()).json().data.state).toBe('ready');
  });

  it('exposes safe actionable failure copy without serializing provider internals', async () => {
    const { status } = await setup(true, () => ({
      requests: 1,
      maxRequests: 100,
      lastError: { code: 'auth', upstreamBody: 'secret upstream body' },
      apiKey: 'secret-key',
    }));
    const response = await status();
    expect(response.json().data).toMatchObject({ state: 'degraded' });
    expect(response.json().data.message).toContain('credentials');
    expect(response.body).not.toContain('secret');
  });

  it('reports an exhausted allowance even after a prior successful request', async () => {
    const { status } = await setup(true, () => ({
      requests: 1,
      maxRequests: 1,
      lastSuccessAt: new Date().toISOString(),
    }));
    expect((await status()).json().data).toMatchObject({
      state: 'degraded',
      message: expect.stringContaining('allowance'),
    });
  });
});
