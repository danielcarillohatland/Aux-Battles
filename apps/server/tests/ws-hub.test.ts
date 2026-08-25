/**
 * WS hub tests (TDD §5/§9, D-D) — bare Fastify + real RoomManager + real
 * sockets on an ephemeral port. Fixtures call RoomManager directly (NOT the
 * REST routes) because routes/rooms.ts carries module-level per-IP rate
 * limiters that a fixture-heavy suite would exhaust. Fake clock is engaged
 * ONLY around time-sensitive assertions — never across app.inject (light-my-
 * request needs real timers).
 *
 * Covered:
 *  - ticket flow: auth required, single-use, 60 s TTL, room-bound;
 *  - upgrade gate: no/expired/replayed/wrong-room tickets rejected pre-socket;
 *  - initial `state_change` full snapshot, schema-valid, seq=1;
 *  - per-room monotonic seq shared by all viewers, continued across reconnects;
 *  - supersession: second dial for same player closes the first (4001);
 *  - protocol enforcement: non ping/ack client frame → close 4400;
 *  - heartbeat: silence past 2 missed beats drops the socket (fake timers);
 *  - hub API: broadcastStateChange / publish / toHosts / kick / closeRoom.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { ServerFrameSchema } from '@aux/shared';
import { RoomManager } from '../src/core/room-manager.js';
import { initWsHub, type WsHub } from '../src/ws/index.js';

interface Ctx {
  app: FastifyInstance;
  rooms: RoomManager;
  wsHub: WsHub;
  url: string;
}

let ctx: Ctx;

interface Session {
  token: string;
  playerId: string;
  code: string;
}

async function startServer(): Promise<Ctx> {
  const app = Fastify({ logger: false });
  const rooms = new RoomManager();
  const wsHub = await initWsHub(app, { roomManager: rooms });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  return { app, rooms, wsHub, url: `ws://127.0.0.1:${addr.port}` };
}

/** Create a room (host) or join one (player); raw credentials, no REST limiter. */
function makeSession(role: 'host' | 'player', code = ''): Session {
  if (role === 'host') {
    const { code: c, hostToken, playerId } = ctx.rooms.createRoom();
    return { code: c, token: hostToken, playerId };
  }
  const r = ctx.rooms.joinRoom(code, `p${Math.random().toString(36).slice(2, 7)}`);
  return { code, token: r.playerToken, playerId: r.playerId };
}

/** Mint a connect ticket against `app` (token travels ONLY in the header). */
async function getTicket(app: FastifyInstance, s: Session): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/ws-ticket',
    headers: { authorization: `Bearer ${s.token}` },
    payload: { code: s.code },
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { data: { ticket: string } }).data.ticket;
}

const ticketFor = (s: Session): Promise<string> => getTicket(ctx.app, s);

/** Loosely-typed received frame for assertions (real validation is ServerFrameSchema's job). */
interface TestFrame {
  t: string;
  seq: number;
  count?: number;
  reason?: string;
  snapshot: { state: string; roomCode: string; roundIdx: number };
  [key: string]: unknown;
}

interface Dial {
  socket: WebSocket;
  /** Frames received so far (live array). */
  readonly frames: unknown[];
  /** Resolves with the WS close code — or the HTTP status if the upgrade itself was rejected. */
  readonly closed: Promise<{ code: number; reason: string }>;
  /** Resolves once ≥ n frames have arrived (own timeout — tests never hang silently). */
  waitFor(n: number, ms?: number): Promise<unknown[]>;
}

/**
 * Dial /ws. A REJECTED upgrade never reaches the WS layer, so `closed`
 * resolves with the HTTP status instead (400/403/404) — distinguishable
 * from real 4xxx WS close codes.
 */
function dial(s: Session, opts: { ticket?: string; query?: string } = {}): Dial {
  const qs =
    opts.query ?? (opts.ticket !== undefined ? `room=${s.code}&ticket=${opts.ticket}` : '');
  const socket = new WebSocket(`${ctx.url}/ws${qs ? `?${qs}` : ''}`);
  const frames: unknown[] = [];
  const waiters: Array<{ n: number; res: (f: unknown[]) => void; timer: NodeJS.Timeout }> = [];

  const pump = (): void => {
    const w = waiters[0];
    if (w !== undefined && frames.length >= w.n) {
      clearTimeout(w.timer);
      waiters.shift();
      w.res(frames);
    }
  };

  socket.on('message', (raw) => {
    frames.push(JSON.parse(String(raw)));
    pump();
  });

  let resolveClosed: (c: { code: number; reason: string }) => void = () => {};
  const closed = new Promise<{ code: number; reason: string }>((r) => (resolveClosed = r));
  socket.on('close', (code, reason) => resolveClosed({ code, reason: reason.toString() }));
  // Rejected handshake surfaces as 'unexpected-response' + 'error' on the client.
  socket.on('unexpected-response', (_req: unknown, res: { statusCode: number }) =>
    resolveClosed({ code: res.statusCode, reason: 'upgrade rejected' }),
  );
  socket.on('error', () => {}); // rejection detail already captured above
  openSockets.add(socket);
  socket.on('close', () => openSockets.delete(socket));

  return {
    socket,
    frames,
    closed,
    waitFor(n: number, ms = 2_000): Promise<unknown[]> {
      return new Promise<unknown[]>((res, rej) => {
        const entry = {
          n,
          res,
          timer: setTimeout(
            () => rej(new Error(`timed out waiting for ${n} frames (have ${frames.length})`)),
            ms,
          ),
        };
        waiters.push(entry);
        pump();
      });
    },
  };
}

/** Sockets opened during a test — force-closed in afterEach so nothing leaks. */
const openSockets = new Set<WebSocket>();

beforeEach(async () => {
  vi.useRealTimers();
  ctx = await startServer();
});

afterEach(async () => {
  vi.useRealTimers();
  for (const socket of openSockets) socket.terminate();
  openSockets.clear();
  await ctx.app.close();
});

describe('connect tickets (POST /api/v1/ws-ticket)', () => {
  it('requires authentication — no token, no ticket', async () => {
    const host = makeSession('host');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/ws-ticket',
      payload: { code: host.code },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ ok: false, error: { code: 'NOT_AUTHENTICATED' } });
  });

  it('rejects a valid token for an unknown room', async () => {
    const host = makeSession('host');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/ws-ticket',
      headers: { authorization: `Bearer ${host.token}` },
      payload: { code: 'ZZZZZ' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a malformed room code', async () => {
    const host = makeSession('host');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/ws-ticket',
      headers: { authorization: `Bearer ${host.token}` },
      payload: { code: '!!!' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('mints a working ticket from a Bearer header (token never in query)', async () => {
    const host = makeSession('host');
    const ticket = await ticketFor(host); // asserts 200
    expect(ticket.length).toBeGreaterThan(20);
  });

  it('tickets are single-use: replay is refused at the upgrade', async () => {
    const host = makeSession('host');
    const ticket = await ticketFor(host);

    const first = dial(host, { ticket });
    const initial = ((await first.waitFor(1))[0] ?? {}) as TestFrame;
    expect(initial.t).toBe('state_change');
    first.socket.close();

    const second = dial(host, { ticket }); // replay!
    expect((await second.closed).code).toBe(403);
    await new Promise<void>((r) => setTimeout(r, 50));
    expect(ctx.wsHub.connectionCount(host.code)).toBe(0);
  });
});

describe('upgrade gate (/ws)', () => {
  it('rejects a missing ticket', async () => {
    const host = makeSession('host');
    const d = dial(host, { query: `room=${host.code}` });
    expect((await d.closed).code).toBe(400);
  });

  it('rejects an expired ticket (>60 s)', async () => {
    const host = makeSession('host');
    const ticket = await ticketFor(host); // real-timers inject
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 61_000); // clock jumps past TTL
    try {
      const d = dial(host, { ticket }); // sockets deliver via I/O events, not timers
      expect((await d.closed).code).toBe(403);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a ticket presented for a different room', async () => {
    const host = makeSession('host');
    const stranger = makeSession('host');
    const ticket = await ticketFor(host);
    const d = dial(stranger, { query: `room=${stranger.code}&ticket=${ticket}` });
    expect((await d.closed).code).toBe(403);
  });
});

describe('push stream', () => {
  it('opens with a schema-valid full state_change, seq=1', async () => {
    const host = makeSession('host');
    const d = dial(host, { ticket: await ticketFor(host) });
    const frame = ((await d.waitFor(1))[0] ?? {}) as TestFrame;
    expect(ServerFrameSchema.safeParse(frame).success).toBe(true);
    expect(frame).toMatchObject({
      t: 'state_change',
      seq: 1,
      snapshot: { roomCode: host.code, state: 'LOBBY', you: { role: 'host', nickname: 'Host' } },
    });
    d.socket.close();
  });

  it('seq advances monotonically per room, shared by all viewers', async () => {
    const host = makeSession('host');
    const player = makeSession('player', host.code);

    const dh = dial(host, { ticket: await ticketFor(host) });
    const dp = dial(player, { ticket: await ticketFor(player) });
    await Promise.all([dh.waitFor(1), dp.waitFor(1)]);

    ctx.wsHub.publish(host.code, { t: 'submission_received', count: 3 });
    ctx.wsHub.toHosts(host.code, { t: 'playback_cue' });

    const hf = (await dh.waitFor(3)) as TestFrame[];
    const pf = (await dp.waitFor(2)) as TestFrame[];

    // playback_cue is host-only; everyone shares ONE per-room seq ladder.
    expect(hf.slice(1).map((f: TestFrame) => f.t)).toEqual(['submission_received', 'playback_cue']);
    expect(pf.slice(1).map((f: TestFrame) => f.t)).toEqual(['submission_received']);
    const hSeq = (hf[1] as TestFrame | undefined)?.seq ?? -1;
    const pSeq = (pf[1] as TestFrame | undefined)?.seq ?? -2;
    expect(pSeq).toBe(hSeq);
    expect((hf[2] as TestFrame | undefined)?.seq).toBe(hSeq + 1);
    expect(ServerFrameSchema.safeParse(hf[2]).success).toBe(true);

    // A fresh connection continues the SAME ladder: host=1, player=2,
    // submission_received=3, playback_cue=4 → this snapshot is seq 5.
    const fresh = makeSession('player', host.code);
    const df = dial(fresh, { ticket: await ticketFor(fresh) });
    const f1 = ((await df.waitFor(1))[0] ?? {}) as TestFrame;
    expect((f1 as TestFrame).seq).toBe(5);
    df.socket.close();
    dh.socket.close();
    dp.socket.close();
  });

  it('closes with 4400 when a client sends anything but ping/ack', async () => {
    const host = makeSession('host');
    const d = dial(host, { ticket: await ticketFor(host) });
    await d.waitFor(1);

    d.socket.send(JSON.stringify({ t: 'start_game' })); // mutation over WS — forbidden
    expect((await d.closed).code).toBe(4400);

    const d2 = dial(host, { ticket: await ticketFor(host) });
    await d2.waitFor(1);
    d2.socket.send('not json at all');
    expect((await d2.closed).code).toBe(4400);
  });

  it('ping/ack keep the socket alive and are accepted silently', async () => {
    const host = makeSession('host');
    const d = dial(host, { ticket: await ticketFor(host) });
    await d.waitFor(1);
    let closedEarly = false;
    d.socket.on('close', () => (closedEarly = true));
    d.socket.send(JSON.stringify({ t: 'ping', ts: Date.now() }));
    d.socket.send(JSON.stringify({ t: 'ack', ts: Date.now(), seq: 1 }));
    await new Promise<void>((r) => setTimeout(r, 150));
    expect(closedEarly).toBe(false); // liveness frames never close the pipe
    expect(ctx.wsHub.connectionCount(host.code)).toBe(1);
    d.socket.close();
  });
});

describe('supersession & lifecycle', () => {
  it('a second socket for the same player supersedes the first (close 4001)', async () => {
    const host = makeSession('host');
    const first = dial(host, { ticket: await ticketFor(host) });
    await first.waitFor(1);

    const second = dial(host, { ticket: await ticketFor(host) });
    await second.waitFor(1);

    expect((await first.closed).code).toBe(4001); // old loses, newest wins
    expect(ctx.wsHub.connectionCount(host.code)).toBe(1);
    second.socket.close();
  });

  it('heartbeat: silence beyond 2 missed beats drops the socket', async () => {
    const host = makeSession('host');
    const ticket = await ticketFor(host); // real-timers inject
    vi.useFakeTimers(); // must be active BEFORE dial so the heartbeat interval is fake-driven
    try {
      const d = dial(host, { ticket });
      await d.waitFor(1);
      expect(ctx.wsHub.connectionCount(host.code)).toBe(1);

      vi.advanceTimersByTime(16_000); // beat 1 missed (tick at 15 s: not yet stale)
      vi.advanceTimersByTime(32_000); // ticks at 30 s / 45 s — 45 s ≫ 32 s threshold
      await vi.waitFor(() => expect(ctx.wsHub.connectionCount(host.code)).toBe(0), {
        timeout: 2_000,
        interval: 25,
      });
      expect((await d.closed).code).toBe(1006); // hard terminate, not a polite close
    } finally {
      vi.useRealTimers();
    }
  });

  it('kick pushes the kicked frame then closes that player only', async () => {
    const host = makeSession('host');
    const player = makeSession('player', host.code);

    const dp = dial(player, { ticket: await ticketFor(player) });
    await dp.waitFor(1);
    const dh = dial(host, { ticket: await ticketFor(host) });
    await dh.waitFor(1);

    ctx.wsHub.kick(host.code, player.playerId, 'bad vibes');

    const pf = (await dp.waitFor(2)) as TestFrame[];
    expect(pf[pf.length - 1]).toMatchObject({ t: 'kicked', reason: 'bad vibes' });
    expect(ServerFrameSchema.safeParse(pf[pf.length - 1]).success).toBe(true);

    await new Promise<void>((r) => setTimeout(r, 100));
    expect(ctx.wsHub.connectionCount(host.code)).toBe(1); // host untouched
    dh.socket.close();
  });

  it('closeRoom notifies everyone and retires the room state', async () => {
    const host = makeSession('host');
    const player = makeSession('player', host.code);
    const dh = dial(host, { ticket: await ticketFor(host) });
    const dp = dial(player, { ticket: await ticketFor(player) });
    await Promise.all([dh.waitFor(1), dp.waitFor(1)]);

    ctx.wsHub.closeRoom(host.code, 'expired');

    const hf = (await dh.waitFor(2)) as TestFrame[];
    expect(hf[hf.length - 1]).toMatchObject({ t: 'room_closed', reason: 'expired' });
    const pf = (await dp.waitFor(2)) as TestFrame[];
    expect((pf[pf.length - 1] as TestFrame).t).toBe('room_closed');

    await new Promise<void>((r) => setTimeout(r, 100));
    expect(ctx.wsHub.connectionCount()).toBe(0);
  });

  it('buildSnapshot override flows through broadcastStateChange verbatim', async () => {
    const customApp = Fastify({ logger: false });
    const rooms = new RoomManager();
    const custom: WsHub = await initWsHub(customApp, {
      roomManager: rooms,
      buildSnapshot: (code, viewer) => ({
        roomCode: code,
        state: 'SONG_SELECTION',
        roundIdx: 2,
        phaseEndsAt: 12345,
        playbackMode: 'api',
        players: [],
        submissionsCount: 7,
        you: { role: viewer.role, hasSubmitted: true, nickname: viewer.nickname },
      }),
    });
    await customApp.listen({ port: 0, host: '127.0.0.1' });
    const addr = customApp.server.address() as { port: number };
    const savedUrl = ctx.url;
    ctx.url = `ws://127.0.0.1:${String(addr.port)}`;
    try {
      const { code, hostToken } = rooms.createRoom();
      const host: Session = { code, token: hostToken, playerId: '' };
      const ticket = await getTicket(customApp, host);

      const d = dial(host, { ticket });
      const frame = ((await d.waitFor(1))[0] ?? {}) as TestFrame;
      expect(frame.snapshot).toMatchObject({
        state: 'SONG_SELECTION',
        roundIdx: 2,
        submissionsCount: 7,
      });
      custom.broadcastStateChange(code);
      const frames = (await d.waitFor(2)) as TestFrame[];
      expect((frames[1] as TestFrame).snapshot.state).toBe('SONG_SELECTION');
      expect((frames[1] as TestFrame).seq).toBe(2);
      d.socket.close();
    } finally {
      ctx.url = savedUrl;
      await customApp.close();
    }
  });
});
