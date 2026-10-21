import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/index.js';

describe('host game allowance at the room boundary', () => {
  let server: Awaited<ReturnType<typeof buildServer>>;
  beforeAll(async () => {
    server = await buildServer({ NODE_ENV: 'test', AUX_DB_FILE: ':memory:', LOG_LEVEL: 'error' });
  });
  afterAll(async () => {
    await server.app.close();
  });

  it('creates free crowd rooms without a host account and rejects forged account tokens', async () => {
    const forged = await server.app.inject({
      method: 'POST',
      url: '/api/v1/rooms',
      headers: { authorization: 'Bearer forged' },
    });
    expect(forged.statusCode).toBe(401);
    const response = await server.app.inject({ method: 'POST', url: '/api/v1/rooms' });
    const code = response.json().data.code as string;
    expect(server.roomManager.get(code)?.billingAccountId).toBeUndefined();
    expect(
      (await server.app.inject(`/api/v1/rooms/${code}/snapshot`)).json().data.judgingMode,
    ).toBe('crowd');
  });

  it('reserves once at start, requires player consent, and refunds an AI outage once', async () => {
    const session = server.billing.createHostSession('test-verified-apple-subject');
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/v1/rooms',
      headers: { authorization: `Bearer ${session.token}` },
    });
    const host = response.json().data as { code: string; hostToken: string };
    const key = `${host.code}:${server.roomManager.get(host.code)!.createdAt}`;
    expect(server.billing.getAccount(session.account.id)?.credits).toBe(1);
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url: `/api/v1/rooms/${host.code}/join`,
          payload: { nickname: 'Guest' },
        })
      ).statusCode,
    ).toBe(400);
    const joined = await server.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${host.code}/join`,
      payload: { nickname: 'Guest', aiConsent: true },
    });
    const action = (token: string) =>
      server.app.inject({
        method: 'POST',
        url: `/api/v1/rooms/${host.code}/host/start_game`,
        headers: { authorization: `Bearer ${token}` },
      });
    expect((await action(joined.json().data.playerToken)).statusCode).toBe(403);
    expect(server.billing.getAccount(session.account.id)?.credits).toBe(1);
    const starts = await Promise.all([action(host.hostToken), action(host.hostToken)]);
    expect(starts.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(server.billing.getAccount(session.account.id)?.credits).toBe(0);
    expect(server.billing.canContinueGame(key, 1)).toBe(true);
    expect(server.billing.canContinueGame(key, 6)).toBe(false);
    server.billing.refundGame(key, 'provider_timeout');
    server.billing.refundGame(key, 'provider_timeout');
    expect(server.billing.getAccount(session.account.id)?.credits).toBe(1);
    expect(server.billing.canContinueGame(key, 1)).toBe(false);
    const serialized = server.roomManager.serialize(host.code)!;
    expect(serialized.billingAccountId).toBe(session.account.id);
    expect(JSON.stringify(server.roomManager.snapshot(host.code))).not.toContain(
      session.account.id,
    );
  });

  it('caps room admission before additional submissions can increase AI spending', async () => {
    const response = await server.app.inject({ method: 'POST', url: '/api/v1/rooms' });
    const code = response.json().data.code as string;
    for (let i = 0; i < 8; i++) {
      expect(
        (
          await server.app.inject({
            method: 'POST',
            url: `/api/v1/rooms/${code}/join`,
            payload: { nickname: `DJ${i}` },
          })
        ).statusCode,
      ).toBe(200);
    }
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url: `/api/v1/rooms/${code}/join`,
          payload: { nickname: 'Overflow' },
        })
      ).statusCode,
    ).toBe(409);
  });
});
