/**
 * Open AI access (portfolio/party deployment): anyone can host an AI-judged
 * room without an account, bounded by a site-wide daily game cap and the
 * durable spending budgets. No model request is made in these tests.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/index.js';
import { OPEN_AI_ACCOUNT_ID } from '../src/billing/ledger.js';
import { judgeNoticeFor } from '../src/core/round-orchestrator.js';

const servers: Awaited<ReturnType<typeof buildServer>>[] = [];
let clientAddress = 0;

afterEach(async () => {
  await Promise.all(servers.splice(0).map(({ app }) => app.close()));
});

async function setup(env: NodeJS.ProcessEnv = {}) {
  const server = await buildServer({
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    AUX_SONG_SEARCH: '0',
    OPENROUTER_API_KEY: 'test-key-never-called',
    ...env,
  });
  servers.push(server);
  // Distinct client addresses keep the shared per-IP create limit out of these tests.
  const create = async (body: Record<string, unknown> = {}) =>
    (
      await server.app.inject({
        method: 'POST',
        url: '/api/v1/rooms',
        payload: body,
        remoteAddress: `10.9.0.${(clientAddress += 1)}`,
      })
    ).json().data as { code: string; hostToken: string };
  const mode = async (code: string) =>
    (await server.app.inject({ url: `/api/v1/rooms/${code}/snapshot` })).json().data.judgingMode;
  const start = async (code: string, hostToken: string) => {
    for (const nickname of ['Riley', 'Morgan']) {
      await server.app.inject({
        method: 'POST',
        url: `/api/v1/rooms/${code}/join`,
        payload: { nickname, aiConsent: true },
      });
    }
    return server.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${code}/host/start_game`,
      headers: { authorization: `Bearer ${hostToken}` },
    });
  };
  return { ...server, create, mode, start };
}

describe('open AI access', () => {
  it('gives every new room the AI judge by default and advertises it', async () => {
    const { app, create, mode } = await setup();
    const room = await create();
    expect(await mode(room.code)).toBe('ai');
    const config = (await app.inject({ url: '/api/v1/billing/config' })).json().data;
    expect(config.aiAccess).toBe('open');
  });

  it('lets the host choose crowd voting instead', async () => {
    const { create, mode } = await setup();
    expect(await mode((await create({ judge: 'crowd' })).code)).toBe('crowd');
  });

  it('still asks players to consent before their picks go to the AI provider', async () => {
    const { app, create } = await setup();
    const room = await create();
    const join = (payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: `/api/v1/rooms/${room.code}/join`, payload });
    expect((await join({ nickname: 'Riley' })).statusCode).toBe(400);
    expect((await join({ nickname: 'Riley', aiConsent: true })).statusCode).toBe(200);
  });

  it('reserves a free game at start without credits, under the house account', async () => {
    const server = await setup();
    const room = await server.create();
    expect((await server.start(room.code, room.hostToken)).statusCode).toBe(200);
    const createdAt = server.roomManager.get(room.code)!.createdAt;
    expect(server.billing.getGame(`${room.code}:${createdAt}`)).toMatchObject({
      accountId: OPEN_AI_ACCOUNT_ID,
      status: 'active',
    });
  });

  it('falls back to crowd voting once the daily free allowance is used up', async () => {
    const server = await setup({ AUX_OPEN_AI_DAILY_GAMES: '1' });
    const first = await server.create();
    const second = await server.create();
    expect((await server.start(first.code, first.hostToken)).statusCode).toBe(200);
    expect((await server.start(second.code, second.hostToken)).statusCode).toBe(200);
    expect(await server.mode(first.code)).toBe('ai');
    expect(await server.mode(second.code)).toBe('crowd');
  });

  it('keeps the paid model when configured, and stays off without a model key', async () => {
    const paid = await setup({ AUX_AI_ACCESS: 'account' });
    expect(await paid.mode((await paid.create()).code)).toBe('crowd');
    const keyless = await setup({ OPENROUTER_API_KEY: '' });
    expect(await keyless.mode((await keyless.create()).code)).toBe('crowd');
    await expect(setup({ AUX_AI_ACCESS: 'everyone' })).rejects.toThrow('AUX_AI_ACCESS');
  });

  it('defaults to small caps on a free public site', async () => {
    const server = await setup();
    expect(server.billing.limits).toMatchObject({
      dailyBudgetMicros: 500_000,
      monthlyBudgetMicros: 3_000_000,
    });
    const paid = await setup({ AUX_AI_ACCESS: 'account' });
    expect(paid.billing.limits.dailyBudgetMicros).toBe(5_000_000);
    const tuned = await setup({ AUX_AI_DAILY_BUDGET_MICROS: '200000' });
    expect(tuned.billing.limits.dailyBudgetMicros).toBe(200_000);
  });

  it('caps free games at 30 a day by default', async () => {
    const server = await setup();
    const day = Date.parse(new Date().toISOString().slice(0, 10));
    for (let index = 0; index < 30; index += 1) {
      server.billing.reserveOpenGame(`SEED${index}:${day}`, 30);
    }
    const room = await server.create();
    expect((await server.start(room.code, room.hostToken)).statusCode).toBe(200);
    expect(await server.mode(room.code)).toBe('crowd');
  });

  it('tells the room DJ AUX is off duty instead of silently switching to votes', async () => {
    const server = await setup({ AUX_OPEN_AI_DAILY_GAMES: '0' });
    const room = await server.create();
    await server.start(room.code, room.hostToken);
    const snapshot = await server.app.inject({
      url: `/api/v1/rooms/${room.code}/snapshot`,
      headers: { authorization: `Bearer ${room.hostToken}` },
    });
    expect(snapshot.json().data.judgeNotice).toBe('off_duty');
    const status = await server.app.inject({
      url: `/api/v1/rooms/${room.code}/judge/status`,
      headers: { authorization: `Bearer ${room.hostToken}` },
    });
    expect(status.json().data).toMatchObject({ state: 'offline' });
    expect(status.json().data.message).toContain('off duty');

    const chosen = await server.create({ judge: 'crowd' });
    const chosenSnapshot = await server.app.inject({
      url: `/api/v1/rooms/${chosen.code}/snapshot`,
      headers: { authorization: `Bearer ${chosen.hostToken}` },
    });
    expect(chosenSnapshot.json().data.judgeNotice ?? null).toBeNull();
  });
});

describe('crowd fallback notices', () => {
  it('maps fallback reasons to what players are told', () => {
    expect(judgeNoticeFor('budget_exhausted')).toBe('off_duty');
    expect(judgeNoticeFor('timeout')).toBe('unavailable');
    expect(judgeNoticeFor('interrupted')).toBe('unavailable');
    expect(judgeNoticeFor(undefined)).toBeNull();
  });
});
