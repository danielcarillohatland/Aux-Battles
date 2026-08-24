/**
 * Phase-1 route integration tests (TDD §5 wire contract, fastify inject).
 * Pins the REST surface to the shared {ok,data}/{ok:false,error} envelopes.
 *
 * Host-only negative-authZ routes (start / kick / skip …) arrive with the WS
 * hub in Phase 2 — carried review finding #2 is covered here by asserting that
 * public routes reject malformed/absent bodies with a 400 envelope; explicit
 * NOT_HOST / NOT_AUTHENTICATED assertions land with those routes.
 *
 * Rate limits are module-level buckets keyed by req.ip (MVP, TDD §10 item 5):
 * they are NOT reset by building a new server instance, so this file keeps its
 * total create/join/snapshot volume under the configured budgets except in the
 * dedicated over-limit suite.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/index.js';
import { ROOM_ALPHABET, ROOM_CODE_LENGTH } from '@aux/shared';

const API = '/api/v1';
const HOST_DEFAULT_NICKNAME = 'Host';

let app: FastifyInstance;

beforeAll(async () => {
  ({ app } = await buildServer({ LOG_LEVEL: 'error', AUX_DEV_MODE: '0' }));
});

afterAll(async () => {
  await app.close();
});

// ── Envelope helpers: EVERY assertion below goes through these ───────────────

function expectOkEnvelope(res: { statusCode: number; json(): unknown }): Record<string, unknown> {
  expect([200, 201]).toContain(res.statusCode);
  const body = res.json() as { ok?: unknown; data?: unknown };
  expect(body).toHaveProperty('ok', true);
  expect(body).toHaveProperty('data');
  return body.data as Record<string, unknown>;
}

function expectErrorEnvelope(
  res: { statusCode: number; json(): unknown },
  status: number,
  code?: string,
): { code: string; message: string } {
  expect(res.statusCode).toBe(status);
  const body = res.json() as { ok?: unknown; error?: { code?: string; message?: string } };
  expect(body).toHaveProperty('ok', false);
  expect(typeof body.error?.message).toBe('string');
  if (code !== undefined) expect(body.error?.code).toBe(code);
  return body.error as { code: string; message: string };
}

async function createRoom() {
  // Contract body is exactly {} — the host identity is server-assigned.
  const res = await app.inject({ method: 'POST', url: `${API}/rooms`, payload: {} });
  return expectOkEnvelope(res);
}

async function join(code: string, nickname: string) {
  return app.inject({
    method: 'POST',
    url: `${API}/rooms/${code}/join`,
    payload: { nickname },
  });
}

// ── Create room ───────────────────────────────────────────────────────────────

describe('POST /api/v1/rooms', () => {
  it('returns an ok envelope with an unambiguous-alphabet code and host token', async () => {
    const data = createRoom();

    const d = await data;
    expect(typeof d.code).toBe('string');
    expect((d.code as string).length).toBe(ROOM_CODE_LENGTH);
    for (const ch of d.code as string) {
      expect(ROOM_ALPHABET).toContain(ch); // D-A: 31 symbols, no 0/O/1/I/L
    }
    expect(typeof d.hostToken).toBe('string');
    expect((d.hostToken as string).length).toBeGreaterThan(0);
    expect(typeof d.playerId).toBe('string');
  });

  it('mints distinct codes/tokens across creations', async () => {
    const a = await createRoom();
    const b = await createRoom();
    expect(a.code).not.toBe(b.code);
    expect(a.hostToken).not.toBe(b.hostToken);
  });

  it('rejects a non-empty create body with a 400 error envelope', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${API}/rooms`,
      payload: { nickname: 'Host One' }, // strict CreateRoomRequestSchema forbids extras
    });
    expectErrorEnvelope(res, 400);
  });
});

// ── Join flow ────────────────────────────────────────────────────────────────

describe('POST /api/v1/rooms/:code/join', () => {
  it('echoes the joined nickname and returns a player token', async () => {
    const { code } = await createRoom();
    const res = await join(code as string, 'Sam');
    const data = expectOkEnvelope(res);

    expect(data.nickname).toBe('Sam');
    expect(typeof data.playerToken).toBe('string');
    expect((data.playerToken as string).length).toBeGreaterThan(0);
    expect(typeof data.playerId).toBe('string');
  });

  it('rejects duplicate nicknames case-insensitively with 409 NAME_TAKEN', async () => {
    const { code } = await createRoom();
    const roomCode = code as string;
    expect((await join(roomCode, 'Sam')).statusCode).toBeLessThan(400);

    const dup = await join(roomCode, '  sAm  '); // trimmed + lowercased → same player
    expectErrorEnvelope(dup, 409, 'NAME_TAKEN');
  });

  it('returns 404 ROOM_NOT_FOUND for an unknown code', async () => {
    const res = await join('ZZZZZ', 'Sam'); // valid alphabet shape, never minted
    expectErrorEnvelope(res, 404, 'ROOM_NOT_FOUND');
  });

  it.each([
    ['missing nickname', { payload: {} }],
    ['absent body', {}],
    ['empty nickname', { payload: { nickname: '' } }],
  ] as const)('rejects %s with a 400 INVALID_NICKNAME envelope', async (_label, opts) => {
    // exactOptionalPropertyTypes: omit `payload` entirely when absent.
    const res = await app.inject({
      method: 'POST',
      url: `${API}/rooms/ABCDE/join`,
      ...('payload' in opts ? { payload: opts.payload } : {}),
    });
    expectErrorEnvelope(res, 400, 'INVALID_NICKNAME');
  });

  it('rejects a malformed code shape with 404 ROOM_NOT_FOUND (no state oracle)', async () => {
    const res = await join('abc12', 'Sam'); // lowercase/digits outside the alphabet
    expectErrorEnvelope(res, 404, 'ROOM_NOT_FOUND');
  });
});

// ── Snapshot ─────────────────────────────────────────────────────────────────

describe('GET /api/v1/rooms/:code/snapshot', () => {
  it('reflects joined players and the host nickname', async () => {
    const { code } = await createRoom();
    const roomCode = code as string;
    expect((await join(roomCode, 'Sam')).statusCode).toBeLessThan(400);
    expect((await join(roomCode, 'Bob')).statusCode).toBeLessThan(400);

    const res = await app.inject({ method: 'GET', url: `${API}/rooms/${roomCode}/snapshot` });
    const snap = expectOkEnvelope(res);

    expect(snap.roomCode).toBe(roomCode);
    expect(snap.hostNickname).toBe(HOST_DEFAULT_NICKNAME);
    const players = snap.players as Array<{ nickname: string; connected: boolean }>;
    const nicks = players.map((p) => p.nickname);
    expect(nicks).toContain(HOST_DEFAULT_NICKNAME);
    expect(nicks).toContain('Sam');
    expect(nicks).toContain('Bob');
    expect(players.length).toBe(3);
    for (const p of players) expect(p.connected).toBe(true);
  });

  it('404s ROOM_NOT_FOUND for an unknown or malformed room code', async () => {
    expectErrorEnvelope(
      await app.inject({ method: 'GET', url: `${API}/rooms/ZZZZZ/snapshot` }),
      404,
      'ROOM_NOT_FOUND',
    );
    expectErrorEnvelope(
      await app.inject({ method: 'GET', url: `${API}/rooms/nope/snapshot` }),
      404,
      'ROOM_NOT_FOUND',
    );
  });
});

// ── Rate limiting ────────────────────────────────────────────────────────────
// Create budget is 10/hour per IP (module-level bucket). All suites above stay
// well under it; this dedicated suite drives past the limit and pins the
// 429 RATE_LIMITED envelope + Retry-After header.

describe('rate limiting on POST /api/v1/rooms', () => {
  it('returns a 429 RATE_LIMITED envelope once the per-ip create limit is exhausted', async () => {
    let limited: { statusCode: number; json(): unknown } | undefined;
    const cap = 30; // budget remaining after earlier suites + margin
    for (let i = 0; i < cap && !limited; i++) {
      const res = await app.inject({ method: 'POST', url: `${API}/rooms`, payload: {} });
      if (res.statusCode === 429) limited = res;
      else expect(res.statusCode).toBe(201);
    }
    expect(limited).toBeDefined(); // never exhausted the cap without tripping the limiter

    const err = expectErrorEnvelope(limited!, 429, 'RATE_LIMITED');
    expect(err.message.length).toBeGreaterThan(0);
  });

  it('sets a positive integer Retry-After header on 429s', async () => {
    // Bucket already exhausted by the previous test in this suite.
    const res = await app.inject({ method: 'POST', url: `${API}/rooms`, payload: {} });
    expect(res.statusCode).toBe(429);
    const retryAfter = Number(res.headers['retry-after']);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
  });
});
