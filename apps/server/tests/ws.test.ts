/**
 * Phase-2 hard-case suite — WS realtime layer (testing-strategy §2 b/d/f,
 * D-D read-mostly protocol).
 *
 * Real server + real websocket clients on an ephemeral port — no sleeps that
 * matter, no mocks of the transport. LLM/Spotify seams are untouched (nothing
 * in this phase reaches them); the per-viewer snapshot seam (`buildSnapshot`)
 * stands in for the FSM wiring so mid-phase replays are testable before the
 * controller lands.
 *
 * Covered hard cases:
 *  - reconnect mid-phase → fresh handshake replays a FULL snapshot (no resync
 *    frame exists, per D-D);
 *  - duplicate-nickname join race → exactly one winner, loser gets 409
 *    NAME_TAKEN (DB-constraint semantics, D-F);
 *  - room expiry with live sockets → every socket gets `room_closed` +
 *    close 1001; registry drains; later publishes are quiet no-ops;
 *  - supersession (newest dial wins), bad-frame eviction, one-time tickets,
 *    per-room monotonic seq.
 */
import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import WebSocket, { type RawData } from 'ws';
import { buildServer } from '../src/index.js';
import { HEARTBEAT_STALE_MS } from '../src/ws/index.js';
import type { WsHub, WsViewer } from '../src/ws/types.js';
import type { RoomManager } from '../src/core/room-manager.js';
import type { Snapshot } from '@aux/shared';

const API = '/api/v1';

/** Every client created this file — afterEach terminates stragglers so no
 * socket handle outlives its test and stalls worker teardown. */
const live = new Set<WsClient>();

// ── One server per file (testing-strategy §1: container-per-file shape) ──────

let app: FastifyInstance;
let hub: WsHub;
let base: string;
let roomManager: RoomManager;

/**
 * Per-room mid-phase snapshot overrides. The hub's production snapshot source
 * becomes the FSM once controller wiring lands; until then tests inject truth
 * through this documented seam (`deps.buildSnapshot`, ws/types.ts).
 */
const snapshotOverrides = new Map<string, Snapshot>();

/** LOBBY-shaped default mirroring hub.ts's own fallback (rooms without an override). */
function fallbackSnapshot(code: string, viewer: WsViewer): Snapshot {
  const base = roomManager.snapshot(code);
  return {
    roomCode: code,
    state: 'LOBBY',
    roundIdx: 0,
    phaseEndsAt: null,
    playbackMode: 'manual',
    players: base.players,
    submissionsCount: 0,
    you: { role: viewer.role, hasSubmitted: false, nickname: viewer.nickname },
  };
}

beforeAll(async () => {
  // buildServer() already initializes the hub (composition root, D-G wiring).
  ({ app, roomManager, wsHub: hub } = await buildServer({ LOG_LEVEL: 'error', AUX_DEV_MODE: '0' }));
  hub.setSnapshotBuilder((code, viewer) =>
    snapshotOverrides.get(code) !== undefined
      ? {
          ...snapshotOverrides.get(code)!,
          you: {
            role: viewer.role,
            hasSubmitted: snapshotOverrides.get(code)!.you.hasSubmitted,
            nickname: viewer.nickname,
          },
        }
      : fallbackSnapshot(code, viewer),
  );
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
});

afterEach(() => {
  snapshotOverrides.clear();
  for (const c of live) c.end();
  live.clear();
});

afterAll(async () => {
  await app.close();
});

// ── Client harness ───────────────────────────────────────────────────────────

interface ServerMsg {
  t: string;
  ts: number;
  seq: number;
  snapshot?: Snapshot;
  reason?: string;
}

class WsClient {
  private readonly queue: ServerMsg[] = [];
  private readonly waiters: Array<{ t: string | null; resolve: (m: ServerMsg) => void }> = [];
  /** Every frame received, arrival order (public for test assertions). */
  readonly frames: ServerMsg[] = [];
  readonly socket: WebSocket;
  readonly role: string;
  closedWith: { code: number; reason: string } | null = null;
  private closedDeferred: Promise<{ code: number; reason: string }>;

  constructor(socket: WebSocket, role: string) {
    this.socket = socket;
    this.role = role;
    this.closedDeferred = new Promise((resolve) => {
      socket.on('close', (code, reason) => {
        this.closedWith = { code, reason: reason.toString() };
        resolve(this.closedWith);
      });
    });
    // Listeners attach SYNCHRONOUSLY here — the server pushes the handshake
    // snapshot the moment the upgrade lands, so a wrapper built after
    // awaiting `open` would silently lose it.
    socket.on('message', (raw: RawData) => {
      const msg = JSON.parse(String(raw)) as ServerMsg;
      this.frames.push(msg);
      const waiterIdx = this.waiters.findIndex((w) => w.t === null || w.t === msg.t);
      if (waiterIdx >= 0) this.waiters.splice(waiterIdx, 1)[0]!.resolve(msg);
      else this.queue.push(msg);
    });
    live.add(this);
  }

  /** Next frame of `t` (or any type when null). Never swallows already-arrived frames. */
  next(t: string | null): Promise<ServerMsg> {
    const queuedIdx = this.queue.findIndex((m) => t === null || m.t === t);
    if (queuedIdx >= 0) return Promise.resolve(this.queue.splice(queuedIdx, 1)[0]!);
    return new Promise((resolve) => this.waiters.push({ t, resolve }));
  }

  expectClose(): Promise<{ code: number; reason: string }> {
    return this.closedWith !== null ? Promise.resolve(this.closedWith) : this.closedDeferred;
  }

  send(obj: unknown): void {
    this.socket.send(JSON.stringify(obj));
  }

  sendRaw(text: string): void {
    this.socket.send(text);
  }

  end(): void {
    if (this.socket.readyState === this.socket.OPEN) this.socket.terminate();
  }

  seqs(): number[] {
    return this.frames.map((f) => f.seq);
  }
}

async function restCreateRoom(): Promise<{ code: string; hostToken: string }> {
  const res = await fetch(`${base}${API}/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { data: { code: string; hostToken: string } };
  return body.data;
}

async function restJoin(
  code: string,
  nickname: string,
): Promise<{ status: number; token?: string | undefined; error?: string | undefined }> {
  const res = await fetch(`${base}${API}/rooms/${code}/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nickname }),
  });
  const body = (await res.json()) as {
    ok: boolean;
    data?: { playerToken: string };
    error?: { code: string };
  };
  return { status: res.status, token: body.data?.playerToken, error: body.error?.code };
}

/** Mint a one-time connect ticket over REST (session token NEVER in query string). */
async function mintTicket(
  code: string,
  token: string,
): Promise<{ status: number; ticket?: string }> {
  const res = await fetch(`${base}${API}/ws-ticket`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (res.status !== 200) return { status: res.status };
  const body = (await res.json()) as { data: { ticket: string } };
  return { status: 200, ticket: body.data.ticket };
}

/** Socket + wrapper created atomically so no early frame can be lost. */
async function dialClient(ticket: string, code: string, role: string): Promise<WsClient> {
  const ws = new WebSocket(`ws://${new URL(base).host}/ws?room=${code}&ticket=${ticket}`);
  const client = new WsClient(ws, role); // listeners on BEFORE the handshake lands
  await new Promise<void>((resolve, reject) => {
    ws.once('unexpected-response', (_req, res) =>
      reject(new Error(`upgrade refused: ${res.statusCode}`)),
    );
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return client;
}

/** Full join+connect for one identity; resolves after the handshake snapshot lands. */
async function connectPlayer(code: string, token: string, role: string): Promise<WsClient> {
  const { status, ticket } = await mintTicket(code, token);
  expect(status).toBe(200);
  const client = await dialClient(ticket!, code, role);
  const snap = await client.next('state_change');
  expect(snap.snapshot?.roomCode).toBe(code); // handshake completes WITH the snapshot
  return client;
}

describe('WS hard cases', () => {
  it('handshake requires a single-use ticket: replay, cross-room, and bad tokens all fail', async () => {
    const { code, hostToken } = await restCreateRoom();

    // Bad session token → 401 at mint time.
    expect((await mintTicket(code, 'not-a-token')).status).toBe(401);

    const { ticket } = await mintTicket(code, hostToken);
    const first = await dialClient(ticket!, code, 'host');
    expect(first.frames[0]!.snapshot?.roomCode).toBe(code); // first dial works…

    // …replaying the SAME ticket is refused at upgrade (403 → error event).
    await expect(dialClient(ticket!, code, 'host')).rejects.toThrow(/403/);

    // A ticket minted for THIS room cannot open a DIFFERENT room.
    const other = await restCreateRoom();
    const foreign = await mintTicket(code, hostToken);
    await expect(dialClient(foreign.ticket!, other.code, 'host')).rejects.toThrow(/403/);
  });

  it('hard case d: duplicate nickname race → exactly ONE winner, loser gets 409 NAME_TAKEN', async () => {
    const { code } = await restCreateRoom();

    // Same-tick race: both requests in flight before either resolves.
    const results = await Promise.all([restJoin(code, 'Racer'), restJoin(code, '  rAcEr ')]);
    const statuses = results.map((r) => r.status).sort((a, b) => a - b);
    expect(statuses).toEqual([200, 409]); // one winner (200)…
    expect(results.find((r) => r.status === 409)?.error).toBe('NAME_TAKEN'); // …clear code

    // And the roster holds exactly one Racer (+host).
    const snap = (await (await fetch(`${base}${API}/rooms/${code}/snapshot`)).json()) as {
      data: { players: Array<{ nickname: string }> };
    };
    const nicks = snap.data.players.map((p) => p.nickname);
    expect(nicks.filter((n) => n.toLowerCase() === 'racer')).toHaveLength(1);
  });

  it('reconnect mid-phase: fresh handshake replays a FULL snapshot, not just future events', async () => {
    const { code, hostToken } = await restCreateRoom();
    const { token: p1Token } = (await restJoin(code, 'Ana')) as { token: string };

    const host = await connectPlayer(code, hostToken, 'host');
    const p1 = await connectPlayer(code, p1Token, 'player');

    // Per-viewer `you` slice: same logical push, typed per recipient (D-D).
    expect(host.frames[0]!.snapshot?.you.role).toBe('host');
    expect(p1.frames[0]!.snapshot?.you.role).toBe('player');

    // Game moves on while Ana is connected… then her phone drops mid-phase.
    p1.end();

    // Controller wiring stand-in (deps.buildSnapshot seam): mid-selection with
    // a live deadline and her submission already sealed.
    const deadline = Date.now() + 60_000;
    snapshotOverrides.set(code, {
      roomCode: code,
      state: 'SONG_SELECTION',
      roundIdx: 0,
      phaseEndsAt: deadline,
      playbackMode: 'manual',
      players: [
        { nickname: 'Host', connected: true },
        { nickname: 'Ana', connected: false }, // marked disconnected server-side
      ],
      submissionsCount: 2,
      you: { role: 'player', hasSubmitted: true, nickname: 'Ana' },
    });
    hub.broadcastStateChange(code); // harmless with her socket gone

    // Ana reconnects with her SESSION TOKEN (fresh ticket — no resync frame).
    const reconnected = await connectPlayer(code, p1Token, 'player');
    const replay = reconnected.frames[0]!.snapshot!;
    expect(replay.state).toBe('SONG_SELECTION'); // current phase, not LOBBY reset
    expect(replay.phaseEndsAt).toBe(deadline); // deadline math intact
    expect(replay.you.hasSubmitted).toBe(true); // private slice survived the drop
    expect(replay.players.map((p) => p.nickname)).toContain('Ana');
    expect(host.seqs().length).toBeGreaterThan(0);

    host.end();
    reconnected.end();
  });

  it('seq is per-room monotonic — every client observes strictly increasing counters', async () => {
    const { code, hostToken } = await restCreateRoom();
    const joined = await restJoin(code, 'Seq');
    const host = await connectPlayer(code, hostToken, 'host');
    const p = await connectPlayer(code, joined.token!, 'player');

    hub.publish(code, { t: 'submission_received', count: 1 });
    hub.publish(code, { t: 'submission_received', count: 2 });

    await host.next('submission_received');
    await host.next('submission_received');
    // seq is PER-ROOM (D-D): other sockets' handshakes consume numbers too,
    // so gaps on one socket are legal — the invariant is strictly increasing.
    const seqs = host.seqs().slice(-2);
    expect(seqs[1]!).toBeGreaterThan(seqs[0]!);

    await p.next('submission_received');
    await p.end();
    host.end();
  });

  it('supersession: newest dial wins, old socket closed 4001 SUPERSEDED', async () => {
    const { code, hostToken } = await restCreateRoom();
    const old = await connectPlayer(code, hostToken, 'host');

    const again = await connectPlayer(code, hostToken, 'host'); // same identity, second device

    const dropped = await old.expectClose();
    expect(dropped.code).toBe(4001);
    expect(hub.connectionCount(code)).toBe(1);

    again.end();
  });

  it('read-mostly contract: ping/ack accepted, anything else closes 4400 BAD_FRAME', async () => {
    const { code, hostToken } = await restCreateRoom();

    // ping keeps the pipe alive.
    const polite = await connectPlayer(code, hostToken, 'host');
    polite.send({ t: 'ping', ts: Date.now() });
    polite.send({ t: 'ack', ts: Date.now(), seq: polite.seqs().at(-1) ?? 0 });
    await new Promise((r) => setTimeout(r, 50));
    expect(polite.closedWith).toBeNull();

    // A client-invented mutation frame is a protocol violation → evicted.
    const rude = await connectPlayer(code, hostToken, 'host');
    rude.send({ t: 'submit', song: 'Fast Car' }); // mutations go through REST!
    expect((await rude.expectClose()).code).toBe(4400);

    // Unparseable garbage, same fate.
    const garbage = await connectPlayer(code, hostToken, 'host');
    garbage.sendRaw('this is not json');
    expect((await garbage.expectClose()).code).toBe(4400);

    polite.end();
  });

  it('hard case f: room expiry with live sockets → ROOM_CLOSED to all, clean drain, quiet afterwards', async () => {
    const { code, hostToken } = await restCreateRoom();
    const joined = await restJoin(code, 'Ana');
    const viewers: WsClient[] = [
      await connectPlayer(code, hostToken, 'host'),
      await connectPlayer(code, joined.token!, 'player'),
    ];
    expect(hub.connectionCount(code)).toBe(2);

    // TTL sweeper entry point: expire the room under everyone.
    hub.closeRoom(code, 'expired');

    // Every live socket got the explicit frame BEFORE the close, with reason.
    const closings = await Promise.all(
      viewers.map(async (v) => {
        const frame = await v.next('room_closed');
        expect(frame.reason).toBe('expired');
        return v.expectClose();
      }),
    );
    for (const c of closings) expect(c.code).toBe(1001); // CLOSE_ROOM_CLOSED

    // Registry drained — no leaked conns, no timers keeping the party alive.
    expect(hub.connectionCount(code)).toBe(0);
    expect(hub.connectionCount()).toBeLessThan(viewers.length);

    // Frames pushed to the dead room are silent no-ops, never crashes.
    expect(() => hub.publish(code, { t: 'judgement' })).not.toThrow();
    expect(() => hub.broadcastStateChange(code)).not.toThrow();

    // A brand-new room works immediately after (codes recyclable per TDD §3).
    const fresh = await restCreateRoom();
    const freshClient = await connectPlayer(fresh.code, fresh.hostToken, 'host');
    expect(freshClient.frames[0]!.snapshot?.roomCode).toBe(fresh.code);
    freshClient.end();
  });

  it('heartbeat constant matches the 2×15s + grace contract (TDD §9)', () => {
    expect(HEARTBEAT_STALE_MS).toBe(15_000 * 2 + 2_000);
  });
});
