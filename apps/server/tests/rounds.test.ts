/**
 * Phase-3 rounds integration suite — submissions / anonymity / races
 * (testing-strategy §2 hard cases; TDD §5 wire contract + §6 constraint-races).
 *
 * Contracts pinned here (siblings own the impl):
 *  - POST /api/v1/rounds/:id/submissions {clientMsgId, track} + Bearer player
 *    token → 200/201; repeat (different song) → 409 ALREADY_SUBMITTED; SAME
 *    clientMsgId replay → the ORIGINAL result, idempotently; non-member token
 *    → 401; submit during LOBBY → 409 INVALID_ACTION.
 *  - GET /api/v1/search?q=… member-auth → {ok,data:{tracks}} with ≤10 tracks.
 *  - Anonymity: `submission_received` WS frames carry COUNT ONLY — no
 *    nickname/playerId anywhere in the raw frame payload (TDD §7).
 *  - Races: 8 parallel submits (distinct players) all succeed with counts
 *    1..8 broadcast; same-player double-submit race → exactly one winner;
 *    quorum early-fire: ALL_SUBMITTED flips SONG_SELECTION→LOCKED the moment
 *    count reaches the roster.
 *
 * Self-skipping: this suite activates AUTOMATICALLY once routes/rounds.ts +
 * routes/search.ts (+ their core deps) land and are wired into index.ts.
 * Until then every test SKIPS with the reason, keeping the gate green —
 * same guard pattern as spotify-provider.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it, type TestContext } from 'vitest';
import WebSocket, { type RawData } from 'ws';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/index.js';
import { TrackSchema } from '@aux/shared';

const API = '/api/v1';

// ── One server per file ───────────────────────────────────────────────────────

let app: FastifyInstance;
let base = '';

/**
 * Per-area readiness: the submissions endpoint (rounds.ts + orchestrator
 * wiring) and the search proxy land independently, so one sibling missing
 * must not skip the other's tests.
 */
let moduleSkip = ''; // a sibling FILE is missing entirely → skip everything
let roundsWired = false; // POST /api/v1/rounds/:id/submissions registered
let searchWired = false; // GET /api/v1/search registered

/** Skip while ANY Phase-3 sibling file is still absent. */
function requireReady(ctx: TestContext): void {
  if (moduleSkip !== '') ctx.skip(true, moduleSkip);
}

/** Skip until routes/rounds.ts (+ orchestrator) is wired into index.ts. */
function requireRounds(ctx: TestContext): void {
  requireReady(ctx);
  if (!roundsWired) {
    ctx.skip(true, 'routes/rounds.ts exists but is not wired into index.ts yet');
  }
}

/** Skip until routes/search.ts is wired into index.ts. */
function requireSearch(ctx: TestContext): void {
  requireReady(ctx);
  if (!searchWired) {
    ctx.skip(true, 'routes/search.ts exists but is not wired into index.ts yet');
  }
}

/** A Fastify default 404 has NO `ok` field — that means "route not registered". */
function hasErrorEnvelope(res: { statusCode: number; json(): unknown }): boolean {
  let body: unknown;
  try {
    body = res.json();
  } catch {
    return false;
  }
  return (body as { ok?: unknown } | null)?.ok === false;
}

beforeAll(async () => {
  // 1) Module probe — do the sibling files exist at all?
  const missing: string[] = [];
  for (const mod of [
    '../src/routes/rounds.js',
    '../src/routes/search.js',
    '../src/core/submissions.js',
    '../src/core/round-orchestrator.js',
  ]) {
    try {
      await import(mod);
    } catch {
      missing.push(mod.replace('../src/', '').replace('.js', '.ts'));
    }
  }
  if (missing.length > 0) {
    moduleSkip = `not implemented yet: ${missing.join(', ')}`;
  }

  // Build the server regardless so helpers resolve; tests skip while guarded.
  ({ app } = await buildServer({
    LOG_LEVEL: 'error',
    AUX_DEV_MODE: '0',
    AUX_DB_FILE: ':memory:',
  }));

  // 2) Wiring probes — are the Phase-3 routes actually registered?
  roundsWired = hasErrorEnvelope(
    await app.inject({ method: 'POST', url: `${API}/rounds/ABCDE:0/submissions`, payload: {} }),
  );
  searchWired = hasErrorEnvelope(await app.inject({ method: 'GET', url: `${API}/search?q=a` }));

  // Real listen ONLY for the WS anonymity/race suites (frames need sockets).
  if (moduleSkip === '' && roundsWired) {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address() as { port: number };
    base = `http://127.0.0.1:${addr.port}`;
  }
});

afterAll(async () => {
  await app.close();
});

// ── Envelope helpers (same discipline as routes.test.ts) ─────────────────────

type Injectish = { statusCode: number; json(): unknown };

function expectOk(res: Injectish): Record<string, unknown> {
  expect([200, 201]).toContain(res.statusCode);
  const body = res.json() as { ok?: unknown; data?: unknown };
  expect(body).toHaveProperty('ok', true);
  return body.data as Record<string, unknown>;
}

function expectError(
  res: Injectish,
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

// ── REST fixtures ─────────────────────────────────────────────────────────────

async function createRoom(): Promise<{ code: string; hostToken: string }> {
  const res = await app.inject({ method: 'POST', url: `${API}/rooms`, payload: {} });
  const d = expectOk(res);
  return { code: d.code as string, hostToken: d.hostToken as string };
}

async function join(
  code: string,
  nickname: string,
): Promise<{ playerToken: string; playerId: string }> {
  const res = await app.inject({
    method: 'POST',
    url: `${API}/rooms/${code}/join`,
    payload: { nickname },
  });
  const d = expectOk(res);
  return { playerToken: d.playerToken as string, playerId: d.playerId as string };
}

/** Drive LOBBY → CATEGORY → SCENARIO → SONG_SELECTION via existing host controls. */
async function toSongSelection(code: string, hostToken: string): Promise<void> {
  const host = (action: string, payload?: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: `${API}/rooms/${code}/host/${action}`,
      headers: { authorization: `Bearer ${hostToken}` },
      ...(payload !== undefined ? { payload } : {}),
    });
  expect((await host('start_game')).statusCode).toBeLessThan(400);
  expect((await host('pick_category', { category: 'road trip' })).statusCode).toBeLessThan(400);
  expect((await host('skip_phase')).statusCode).toBeLessThan(400);

  const gs = await app.inject({ method: 'GET', url: `${API}/rooms/${code}/game-state` });
  expect((expectOk(gs) as { state: string }).state).toBe('SONG_SELECTION');
}

let trackSeq = 0;
function makeTrack(title: string): {
  id: string;
  title: string;
  artist: string;
  durationMs: number;
} {
  trackSeq += 1;
  return { id: `fixture-track-${trackSeq}`, title, artist: 'Test Artist', durationMs: 200_000 };
}

function submit(
  code: string,
  token: string,
  body: { clientMsgId: string; track: unknown },
): Promise<Injectish> {
  return app.inject({
    method: 'POST',
    // Round identity is composite `${code}:${roundIdx}` (routes/rounds.ts);
    // every suite here lives in the first round (roundIdx 0).
    url: `${API}/rounds/${code}:0/submissions`,
    headers: { authorization: `Bearer ${token}` },
    payload: body,
  });
}

// ── Submission contract ───────────────────────────────────────────────────────

describe('POST /api/v1/rounds/:id/submissions', () => {
  it('accepts a member submission in SONG_SELECTION, replays idempotently, rejects repeats', async (ctx) => {
    requireRounds(ctx);
    const { code, hostToken } = await createRoom();
    const p1 = await join(code, 'Ada');
    await toSongSelection(code, hostToken);

    // Happy path: 200/201 with a well-formed envelope.
    const first = await submit(code, p1.playerToken, {
      clientMsgId: 'cm-ada-0001',
      track: makeTrack('Song A'),
    });
    const d1 = expectOk(first);
    expect(d1).toBeTypeOf('object');

    // Idempotent replay: SAME clientMsgId → the ORIGINAL result again, no 409.
    const replay = await submit(code, p1.playerToken, {
      clientMsgId: 'cm-ada-0001',
      track: makeTrack('Song A'),
    });
    expect([200, 201]).toContain(replay.statusCode);
    expect(replay.json()).toEqual(first.json()); // byte-identical original result

    // Repeat SUBMISSION (different song, fresh clientMsgId) → ALREADY_SUBMITTED.
    const second = await submit(code, p1.playerToken, {
      clientMsgId: 'cm-ada-0002',
      track: makeTrack('Song B'),
    });
    expectError(second, 409, 'ALREADY_SUBMITTED');

    // Non-member tokens → 401, never an existence oracle. First a REAL token
    // minted for ANOTHER room…
    const outsiderRoom = await createRoom();
    const foreignRes = await submit(code, outsiderRoom.hostToken, {
      clientMsgId: 'cm-bad-0001',
      track: makeTrack('Song C'),
    });
    expectError(foreignRes, 401, 'NOT_AUTHENTICATED');

    // Garbage token behaves identically (no existence oracle either way).
    const garbage = await submit(code, 'not-a-real-token-value', {
      clientMsgId: 'cm-bad-0002',
      track: makeTrack('Song D'),
    });
    expectError(garbage, 401);
  });

  it('rejects a submission during LOBBY with 409 INVALID_ACTION', async (ctx) => {
    requireRounds(ctx);
    const { code, hostToken } = await createRoom();
    const p = await join(code, 'Lobby Larry');
    // Room stays in LOBBY — no start_game.

    const res = await submit(code, p.playerToken, {
      clientMsgId: 'cm-lobby-001',
      track: makeTrack('Too Early'),
    });
    expectError(res, 409, 'INVALID_ACTION');

    // Host token in LOBBY is equally invalid — phase guards beat role.
    const hostTry = await submit(code, hostToken, {
      clientMsgId: 'cm-lobby-002',
      track: makeTrack('Still Too Early'),
    });
    expectError(hostTry, 409, 'INVALID_ACTION');
  });
});

// ── Search proxy ──────────────────────────────────────────────────────────────

describe('GET /api/v1/search', () => {
  it('requires member auth (401 without a token)', async (ctx) => {
    requireSearch(ctx); // search proxy lands independently
    const res = await app.inject({ method: 'GET', url: `${API}/search?q=song` });
    expectError(res, 401, 'NOT_AUTHENTICATED');
  });

  it('returns {ok,data:{tracks}} capped at 10 for a member', async (ctx) => {
    requireSearch(ctx); // search proxy lands independently
    const { hostToken } = await createRoom();

    const res = await app.inject({
      method: 'GET',
      url: `${API}/search?q=${encodeURIComponent('a')}`, // broadest fake-catalog match
      headers: { authorization: `Bearer ${hostToken}` },
    });
    const d = expectOk(res);
    const tracks = d.tracks as unknown[];
    expect(Array.isArray(tracks)).toBe(true);
    expect(tracks.length).toBeLessThanOrEqual(10);
    for (const t of tracks) expect(TrackSchema.safeParse(t).success).toBe(true);
  });

  it('never leaks provider internals — envelope shape only', async (ctx) => {
    requireSearch(ctx); // search proxy lands independently
    const { hostToken } = await createRoom();
    const res = await app.inject({
      method: 'GET',
      url: `${API}/search?q=${encodeURIComponent('song')}`,
      headers: { authorization: `Bearer ${hostToken}` },
    });
    const body = res.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['data', 'ok']);
  });
});

// ── WS harness (trimmed from ws.test.ts) ──────────────────────────────────────

interface ServerMsg {
  t: string;
  ts: number;
  seq: number;
  [key: string]: unknown;
}

class WsClient {
  private readonly queue: ServerMsg[] = [];
  private readonly waiters: Array<{ t: string | null; resolve: (m: ServerMsg) => void }> = [];
  readonly frames: ServerMsg[] = [];
  private readonly socket: WebSocket;

  constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on('message', (raw: RawData) => {
      const msg = JSON.parse(String(raw)) as ServerMsg;
      this.frames.push(msg);
      const idx = this.waiters.findIndex((w) => w.t === null || w.t === msg.t);
      if (idx >= 0) this.waiters.splice(idx, 1)[0]!.resolve(msg);
      else this.queue.push(msg);
    });
  }

  next(t: string | null): Promise<ServerMsg> {
    const idx = this.queue.findIndex((m) => t === null || m.t === t);
    if (idx >= 0) return Promise.resolve(this.queue.splice(idx, 1)[0]!);
    return new Promise((resolve) => this.waiters.push({ t, resolve }));
  }

  end(): void {
    if (this.socket.readyState === this.socket.OPEN) this.socket.terminate();
  }
}

async function connectViewer(code: string, token: string): Promise<WsClient> {
  const ticketRes = await fetch(`${base}${API}/ws-ticket`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  expect(ticketRes.status).toBe(200);
  const ticketBody = (await ticketRes.json()) as { data?: { ticket?: string } };
  const ticket = ticketBody.data?.ticket ?? '';

  const ws = new WebSocket(`ws://${new URL(base).host}/ws?room=${code}&ticket=${ticket}`);
  const client = new WsClient(ws); // listeners attached BEFORE the upgrade lands
  await new Promise<void>((resolve, reject) => {
    ws.once('unexpected-response', (_req, res) =>
      reject(new Error(`upgrade refused: ${res.statusCode}`)),
    );
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  await client.next('state_change'); // handshake completes WITH a full snapshot
  return client;
}

/** Await `n` frames of `t`; rejects (instead of hanging) past `timeoutMs`. */
async function nextN(
  client: WsClient,
  t: string,
  n: number,
  timeoutMs = 10_000,
): Promise<ServerMsg[]> {
  const out: ServerMsg[] = [];
  for (let i = 0; i < n; i++) {
    let timer: NodeJS.Timeout | undefined;
    const frame = await Promise.race([
      client.next(t),
      new Promise<never>((_, rej) => {
        timer = setTimeout(
          () => rej(new Error(`timed out after ${i}/${n} '${t}' frames`)),
          timeoutMs,
        );
      }),
    ]);
    clearTimeout(timer);
    out.push(frame);
  }
  return out;
}

// ── Anonymity (TDD §7): submission_received carries COUNT ONLY ────────────────

describe('submission_received anonymity', () => {
  it('broadcasts count only — no nickname/playerId anywhere in the frame payload', async (ctx) => {
    requireRounds(ctx);
    const { code, hostToken } = await createRoom();
    const p1 = await join(code, 'Secretive Sam');
    await toSongSelection(code, hostToken);

    const observer = await connectViewer(code, hostToken);
    try {
      const res = await submit(code, p1.playerToken, {
        clientMsgId: 'cm-anon-0001',
        track: makeTrack('Mystery Track'),
      });
      expectOk(res);

      const frame = (await nextN(observer, 'submission_received', 1))[0]!;
      expect(frame.count).toBe(1);
      expect(Number.isInteger(frame.count)).toBe(true);

      // Raw-payload audit: the frame may carry NOTHING identity-shaped.
      const allowed = new Set(['t', 'ts', 'seq', 'count']);
      for (const key of Object.keys(frame))
        expect(allowed.has(key), `unexpected key '${key}'`).toBe(true);

      const raw = JSON.stringify(frame);
      expect(raw).not.toContain('Secretive Sam'); // nickname leak?
      expect(raw.toLowerCase()).not.toContain('playerid'); // field-name leak?
      expect(raw.toLowerCase()).not.toContain('nickname');
    } finally {
      observer.end();
    }
  });

  it('keeps the frame inside the shared server-frame vocabulary', async (ctx) => {
    requireRounds(ctx);
    const { code, hostToken } = await createRoom();
    const p1 = await join(code, 'Schema Sam');
    await toSongSelection(code, hostToken);

    const observer = await connectViewer(code, hostToken);
    try {
      expectOk(
        await submit(code, p1.playerToken, {
          clientMsgId: 'cm-schema-01',
          track: makeTrack('Vocabulary'),
        }),
      );
      const frame = (await nextN(observer, 'submission_received', 1))[0]!;
      // Same {t, ts, seq} envelope discipline as every other server frame.
      expect(typeof frame.t).toBe('string');
      expect(Number.isInteger(frame.ts)).toBe(true);
      expect(Number.isInteger(frame.seq)).toBe(true);
    } finally {
      observer.end();
    }
  });
});

// ── Races (TDD §6: DB constraints are the arbiter, no read-modify-write) ──────

describe('submission races', () => {
  it('8 parallel distinct-player submits all succeed; counts 1..8 broadcast', async (ctx) => {
    requireRounds(ctx);
    const { code, hostToken } = await createRoom();
    const players = [];
    for (let i = 0; i < 8; i++) players.push(await join(code, `Racer ${i + 1}`));
    await toSongSelection(code, hostToken);

    const observer = await connectViewer(code, hostToken);
    try {
      const results = await Promise.all(
        players.map((p, i) =>
          submit(code, p.playerToken, {
            clientMsgId: `cm-race-${String(i).padStart(2, '0')}`,
            track: makeTrack(`Race Tune ${i + 1}`),
          }),
        ),
      );

      // EVERY submission wins — uniqueness is per-player, not global.
      for (const [i, res] of results.entries()) {
        expect([200, 201], `racer ${i + 1} got ${res.statusCode}`).toContain(res.statusCode);
      }

      // Broadcast side: eight count-only frames, ladder 1..8 (order-independent).
      const frames = await nextN(observer, 'submission_received', 8);
      const counts = frames.map((f) => f.count as number).sort((a, b) => a - b);
      expect(counts).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    } finally {
      observer.end();
    }
  }, 20_000);

  it('same-player double-submit race → exactly one winner, loser gets 409 ALREADY_SUBMITTED', async (ctx) => {
    requireRounds(ctx);
    const { code, hostToken } = await createRoom();
    const p = await join(code, 'Double Tap');
    await toSongSelection(code, hostToken);

    const [a, b] = await Promise.all([
      submit(code, p.playerToken, { clientMsgId: 'cm-tap-a-0001', track: makeTrack('Tap A') }),
      submit(code, p.playerToken, { clientMsgId: 'cm-tap-b-0001', track: makeTrack('Tap B') }),
    ]);

    const statuses = [a.statusCode, b.statusCode].sort();
    expect(statuses[0]).toBe(409);
    expect([200, 201]).toContain(statuses[1]);
    const loser = a.statusCode === 409 ? a : b;
    expectError(loser, 409, 'ALREADY_SUBMITTED');
  }, 20_000);

  it('quorum early-fire: ALL_SUBMITTED dispatches to LOCKED once everyone submitted', async (ctx) => {
    requireRounds(ctx);
    const { code, hostToken } = await createRoom();
    const q1 = await join(code, 'Quorum One');
    const q2 = await join(code, 'Quorum Two');
    await toSongSelection(code, hostToken);

    const gameState = async (): Promise<string> => {
      const res = await app.inject({ method: 'GET', url: `${API}/rooms/${code}/game-state` });
      return (expectOk(res) as { state: string }).state;
    };
    expect(await gameState()).toBe('SONG_SELECTION');

    // Every roster member submits (host included — the roster IS the quorum).
    // The LAST submission must flip the FSM via ALL_SUBMITTED without waiting
    // anywhere near the 90 s SONG_SELECTION deadline.
    const identities = [
      { token: hostToken, label: 'host' },
      { token: q1.playerToken, label: 'quorum-one' },
      { token: q2.playerToken, label: 'quorum-two' },
    ];
    const startedAt = Date.now();
    let flipped = false;
    for (const [i, { token }] of identities.entries()) {
      const res = await submit(code, token, {
        clientMsgId: `cm-quorum-${String(i).padStart(2, '0')}`,
        track: makeTrack(`Quorum Tune ${i + 1}`),
      });
      expect([200, 201]).toContain(res.statusCode);
      if ((await gameState()) === 'LOCKED') {
        flipped = true; // early-fire happened — done waiting
        break;
      }
    }

    expect(flipped).toBe(true);
    expect(await gameState()).toBe('LOCKED');
    // Fired by the quorum event, NOT the 90 s timer.
    expect(Date.now() - startedAt).toBeLessThan(30_000);
  }, 30_000);
});
