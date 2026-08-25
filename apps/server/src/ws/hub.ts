/**
 * WsHub — read-mostly realtime layer (TDD §5, D-D).
 *
 * Wire rules:
 *  - Clients send ONLY `ping`/`ack` frames (validated against ClientFrameSchema);
 *    every mutation goes through REST. Protocol violations close the socket.
 *  - Server pushes `{t, ts, seq}` envelopes validated against ServerFrameSchema
 *    before send; seq is PER-ROOM monotonic so clients detect gaps and repair
 *    via a fresh handshake + full snapshot (there is no resync frame).
 *  - Auth never touches a query-string session token: POST /api/v1/ws-ticket
 *    exchanges an Authorization-header token for a 60 s single-use connect
 *    ticket (core/connect-tickets.ts); the /ws upgrade consumes it.
 *  - Heartbeat: any client frame refreshes liveness; silence past ~32 s
 *    (2×15 s heartbeat missed + grace) drops the socket.
 *  - Supersession: a second authenticated socket for the same player replaces
 *    the first (phones roam; the newest wins), closing the old with 4001.
 *
 * Integration: call once at composition root —
 *   const wsHub = await initWsHub(app, { roomManager });
 * then push from FSM hooks / REST via the returned handle.
 */
import websocket from '@fastify/websocket';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { ClientFrameSchema, RoomCodeSchema, ServerFrameSchema, apiError } from '@aux/shared';
import type { ServerFrame, Snapshot } from '@aux/shared';
import { ConnectTicketStore, type TicketGrant } from '../core/connect-tickets.js';
import { createRateLimiter, type RateLimiter } from '../core/rate-limit.js';
import { verifyToken } from '../core/tokens.js';
import {
  CLOSE_BAD_FRAME,
  CLOSE_KICKED,
  CLOSE_ROOM_CLOSED,
  CLOSE_SUPERSEDED,
  HEARTBEAT_STALE_MS,
  type PushFrame,
  type WsHub,
  type WsHubDeps,
  type WsViewer,
} from './types.js';

/** ws-ticket mints are cheap but not free — per-IP budget blunts ticket farming. */
const ticketLimiter: RateLimiter = createRateLimiter({ windowMs: 60_000, max: 60 });

interface Conn {
  code: string;
  playerId: string;
  viewer: WsViewer;
  socket: WebSocket;
  lastSeenAt: number;
  heartbeat: NodeJS.Timeout;
}

/** Handshake result smuggled from preValidation to the ws handler (TS-safe). */
const grants = new WeakMap<FastifyRequest, TicketGrant>();

export async function initWsHub(app: FastifyInstance, deps: WsHubDeps): Promise<WsHub> {
  const { roomManager } = deps;

  await app.register(websocket, { options: { maxPayload: 4_096 } });

  // ── Hub state ───────────────────────────────────────────────────────────────
  const tickets = new ConnectTicketStore();
  const rooms = new Map<string, Map<string, Conn>>(); // code → playerId → conn
  const seqByRoom = new Map<string, number>(); // per-room monotonic counter

  const nextSeq = (code: string): number => {
    const seq = (seqByRoom.get(code) ?? 0) + 1;
    seqByRoom.set(code, seq);
    return seq;
  };

  /** Token → identity, or null. Constant-time hash compare (tokens.ts). */
  function authenticate(code: string, token: string): WsViewer | null {
    if (!RoomCodeSchema.safeParse(code).success) return null;
    const room = roomManager.get(code);
    if (room === undefined) return null;
    for (const [playerId, player] of room.players) {
      if (verifyToken(token, player.tokenHash)) {
        return {
          playerId,
          role: playerId === room.hostPlayerId ? 'host' : 'player',
          nickname: player.nickname,
        };
      }
    }
    return null;
  }

  /**
   * Default snapshot: LOBBY-shaped truth from RoomManager. The FSM override
   * (deps.buildSnapshot) replaces this once Phase-2 wiring lands.
   */
  function defaultSnapshot(code: string, viewer: WsViewer): Snapshot | null {
    let base;
    try {
      base = roomManager.snapshot(code);
    } catch {
      return null; // room vanished between frames — caller closes quietly
    }
    return {
      roomCode: code,
      state: 'LOBBY',
      roundIdx: 0,
      phaseEndsAt: null,
      playbackMode: 'manual', // D-E default mode
      players: base.players,
      submissionsCount: 0,
      you: { role: viewer.role, hasSubmitted: false, nickname: viewer.nickname },
    };
  }

  function snapshotFor(code: string, viewer: WsViewer): Snapshot | null {
    return deps.buildSnapshot ? deps.buildSnapshot(code, viewer) : defaultSnapshot(code, viewer);
  }

  /** Post-init override for tests / controller FSM wiring (Phase 3 replaces the default). */
  function setSnapshotBuilder(builder: NonNullable<WsHubDeps['buildSnapshot']>): void {
    deps.buildSnapshot = builder;
  }

  /**
   * Stamp `{ts, seq}` ONCE per logical frame and validate against the shared
   * schema before any send. Seq is PER-ROOM: every viewer of a room must see
   * the identical ladder or client gap-detection breaks (D-D).
   */
  function stamp(code: string, frame: PushFrame): ServerFrame | null {
    const envelope = { ...frame, ts: Date.now(), seq: nextSeq(code) } as ServerFrame;
    const parsed = ServerFrameSchema.safeParse(envelope);
    if (!parsed.success) {
      // Internal invariant bug — log loudly, but never kill the process or fan
      // a bad frame out to clients (D-D: WS stays a trustworthy pipe).
      app.log.error(
        { err: parsed.error.flatten(), t: frame.t },
        'ws: invalid outbound frame dropped',
      );
      return null;
    }
    return parsed.data;
  }

  function send(conn: Conn, envelope: ServerFrame): void {
    if (conn.socket.readyState === conn.socket.OPEN) {
      conn.socket.send(JSON.stringify(envelope));
    }
  }

  function pushTo(conns: Iterable<Conn>, code: string, frame: PushFrame): void {
    const envelope = stamp(code, frame);
    if (envelope === null) return;
    for (const conn of conns) send(conn, envelope);
  }

  function connsOf(code: string): Iterable<Conn> {
    return rooms.get(code)?.values() ?? [];
  }

  function dropConn(code: string, playerId: string, conn: Conn): void {
    clearInterval(conn.heartbeat);
    const roomConns = rooms.get(code);
    if (roomConns?.get(playerId) === conn) roomConns.delete(playerId);
    if (roomConns !== undefined && roomConns.size === 0) rooms.delete(code);
  }

  /** Supersede + register. The OLD socket loses; the newest dial always wins. */
  function register(grant: TicketGrant, socket: WebSocket): Conn {
    const roomConns = rooms.get(grant.code) ?? new Map<string, Conn>();
    rooms.set(grant.code, roomConns);

    const stale = roomConns.get(grant.playerId);
    if (stale !== undefined) {
      stale.socket.close(CLOSE_SUPERSEDED, 'superseded');
      // A peer that ignores the close handshake gets hard-dropped.
      const enforcer = setTimeout(() => {
        if (stale.socket.readyState !== stale.socket.CLOSED) stale.socket.terminate();
      }, 5_000);
      enforcer.unref();
    }

    const viewer: WsViewer = {
      playerId: grant.playerId,
      role: grant.role,
      nickname: grant.nickname,
    };
    const conn: Conn = {
      code: grant.code,
      playerId: grant.playerId,
      viewer,
      socket,
      lastSeenAt: Date.now(),
      heartbeat: setInterval(() => {
        if (Date.now() - conn.lastSeenAt > HEARTBEAT_STALE_MS) {
          // Missed ≥2 heartbeats (TDD §9): assume dead phone, free the slot.
          dropConn(grant.code, grant.playerId, conn);
          socket.terminate();
        }
      }, 15_000),
    };
    conn.heartbeat.unref();
    roomConns.set(grant.playerId, conn);
    return conn;
  }

  // ── REST: token → one-time ticket (never a query-string session token) ─────
  app.post('/api/v1/ws-ticket', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!ticketLimiter.take(`ws-ticket:${req.ip}`)) {
      const retry = ticketLimiter.retryAfterSecs(`ws-ticket:${req.ip}`);
      reply.header('retry-after', String(retry));
      return reply
        .code(429)
        .send(apiError('RATE_LIMITED', 'too many ticket requests', { retryAfterSecs: retry }));
    }

    const body = (req.body ?? {}) as { code?: unknown; token?: unknown };
    const header = req.headers.authorization;
    const bearer =
      typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : null;
    const token = bearer ?? (typeof body.token === 'string' ? body.token : null);
    const code = RoomCodeSchema.safeParse(body.code);

    // Missing credentials are an auth problem (401), not a shape problem.
    if (token === null) {
      return reply
        .code(401)
        .send(apiError('NOT_AUTHENTICATED', 'session token required (Authorization: Bearer …)'));
    }
    if (!code.success) {
      return reply.code(400).send(apiError('INVALID_CODE', 'expected {code} as a room code'));
    }

    const viewer = authenticate(code.data, token);
    if (viewer === null) {
      return reply.code(401).send(apiError('NOT_AUTHENTICATED', 'bad token or unknown room'));
    }

    const ticket = tickets.issue({
      code: code.data,
      playerId: viewer.playerId,
      role: viewer.role,
      nickname: viewer.nickname,
    });
    return reply.send({ ok: true as const, data: { ticket } });
  });

  // ── Upgrade gate: validate + CONSUME the ticket before accepting ───────────
  async function handshake(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const query = req.query as { room?: string; code?: string; ticket?: string };
    const code = query.room ?? query.code ?? '';
    const ticket = query.ticket ?? '';

    if (!RoomCodeSchema.safeParse(code).success || ticket === '') {
      void reply.code(400).send(apiError('INVALID_CODE', 'missing room or ticket'));
      return;
    }

    const grant = tickets.consume(ticket);
    // Unknown, replayed, expired, or wrong-room tickets are all the same 403.
    if (grant === null || grant.code !== code) {
      void reply.code(403).send(apiError('NOT_AUTHENTICATED', 'invalid or expired ticket'));
      return;
    }

    // Identity was fixed at mint time, but the world may have moved on since.
    const room = roomManager.get(code);
    if (room === undefined || !room.players.has(grant.playerId)) {
      void reply.code(404).send(apiError('ROOM_NOT_FOUND', 'no such room'));
      return;
    }

    // WS Origin check (security baseline #6): browsers always send Origin on
    // WS dials; non-browser clients may omit it. Cross-origin upgrades die here.
    const origin = req.headers.origin;
    if (typeof origin === 'string') {
      let originHost: string | null = null;
      try {
        originHost = new URL(origin).host;
      } catch {
        originHost = null;
      }
      const hostHeader = req.headers.host ?? '';
      if (originHost !== null && hostHeader !== '' && originHost !== hostHeader) {
        void reply.code(403).send(apiError('NOT_AUTHENTICATED', 'cross-origin websocket refused'));
        return;
      }
    }

    grants.set(req, grant);
  }

  app.get('/ws', { websocket: true, preValidation: handshake }, (socket, req) => {
    const grant = grants.get(req);
    if (grant === undefined) return; // unreachable behind preValidation guard
    const conn = register(grant, socket);

    // Handshake completes with a full snapshot (reconnect = fresh handshake +
    // full snapshot per D-D; there is no resync frame).
    const snap = snapshotFor(conn.code, conn.viewer);
    if (snap === null) {
      socket.close(CLOSE_ROOM_CLOSED, 'room gone');
      dropConn(conn.code, conn.playerId, conn);
      return;
    }
    const initial = stamp(conn.code, { t: 'state_change', snapshot: snap });
    if (initial !== null) send(conn, initial);

    socket.on('message', (raw: unknown) => {
      conn.lastSeenAt = Date.now();
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(String(raw));
      } catch {
        socket.close(CLOSE_BAD_FRAME, 'frames are JSON');
        return;
      }
      const frame = ClientFrameSchema.safeParse(parsedJson);
      if (!frame.success) {
        // Read-mostly contract: anything beyond ping/ack is a protocol violation.
        socket.close(CLOSE_BAD_FRAME, 'unsupported frame');
        return;
      }
      // ping/ack are liveness ONLY (D-D): the client proves the socket is alive
      // and acknowledges the last seq it saw. The server never replies on this
      // path (`ack` lives in ClientFrameSchema, not ServerFrameSchema) — server
      // liveness is proven by the pushed frames themselves.
    });

    const cleanup = (): void => dropConn(conn.code, conn.playerId, conn);
    socket.on('close', cleanup);
    socket.on('error', cleanup);
  });

  // Optional hygiene: expired tickets are harmless garbage but shouldn't pile up.
  const sweeper = setInterval(() => tickets.sweep(), 60_000);
  sweeper.unref();

  // ── Push surface consumed by REST routes / FSM hooks ────────────────────────
  const hub: WsHub = {
    broadcastStateChange(code: string): void {
      // One seq per logical frame; each viewer gets THEIR OWN snapshot (`you`).
      const conns = [...connsOf(code)];
      if (conns.length === 0) return;
      const seq = nextSeq(code);
      for (const conn of conns) {
        const snap = snapshotFor(code, conn.viewer);
        if (snap === null) continue;
        const envelope = { t: 'state_change', ts: Date.now(), seq, snapshot: snap } as ServerFrame;
        if (ServerFrameSchema.safeParse(envelope).success) send(conn, envelope);
      }
    },

    publish(code: string, frame: PushFrame): void {
      pushTo([...connsOf(code)], code, frame);
    },

    toHosts(code: string, frame: PushFrame): void {
      pushTo(
        [...connsOf(code)].filter((c) => c.viewer.role === 'host'),
        code,
        frame,
      );
    },

    kick(code: string, playerId: string, reason: string): void {
      const roomConns = rooms.get(code);
      const conn = roomConns?.get(playerId);
      if (conn === undefined) return;
      pushTo([conn], code, { t: 'kicked', reason });
      conn.socket.close(CLOSE_KICKED, 'kicked');
      dropConn(code, playerId, conn);
    },

    closeRoom(code: string, reason: string): void {
      pushTo([...connsOf(code)], code, { t: 'room_closed', reason });
      for (const conn of [...connsOf(code)]) {
        conn.socket.close(CLOSE_ROOM_CLOSED, reason);
        dropConn(code, conn.playerId, conn);
      }
      seqByRoom.delete(code);
    },

    connectionCount(code?: string): number {
      if (code !== undefined) return rooms.get(code)?.size ?? 0;
      let n = 0;
      for (const roomConns of rooms.values()) n += roomConns.size;
      return n;
    },

    setSnapshotBuilder,
  };

  return hub;
}
