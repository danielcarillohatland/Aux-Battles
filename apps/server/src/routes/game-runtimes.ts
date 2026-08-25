/**
 * Phase-2 integration runtime (controller wiring, reviewer finding 🔴#1/#2):
 * binds RoomManager + RoomFsm + TimerService + SqliteRoomStore into the
 * composition root so the committed parts become a running machine.
 *
 * Per-room GameRuntime: owns the FSM, arms timers on timed phases (D-C),
 * checkpoints every transition via onChange (D-B), and rehydrates lazily.
 * Boot sweep re-arms overdue deadlines after a crash (D-C).
 */
import { RoomCodeSchema, apiError } from '@aux/shared';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { Analytics } from '../core/analytics.js';
import type { RoomManager } from '../core/room-manager.js';
import type { RoomStore } from '../core/room-store.js';
import { TimerService } from '../core/timers.js';
import { RoomFsm } from '../fsm/engine.js';
import { IllegalTransitionError } from '../fsm/types.js';
import type { FsmEvent, TransitionPayload } from '../fsm/types.js';
import type { FsmState } from '@aux/shared';
import { createRateLimiter, type RateLimiter } from '../core/rate-limit.js';
import { verifyToken } from '../core/tokens.js';

/** Durable checkpoint shape: FSM state + roster linkage. Opaque to RoomStore. */
interface Checkpoint {
  code: string;
  fsmState: string;
  roundIdx: number;
  phaseEndsAt: number | null;
}

export interface GameRuntimesOptions {
  roomManager: RoomManager;
  store: RoomStore;
  analytics: Analytics;
}

const hostActionLimiter = createRateLimiter({ windowMs: 60_000, max: 120 });
const reclaimLimiter = createRateLimiter({ windowMs: 600_000, max: 30 });

/** Extract + verify a Bearer session token against the room's players. */
function authenticate(
  roomManager: RoomManager,
  code: string,
  req: FastifyRequest,
): { playerId: string; isHost: boolean } | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  const token = header.slice(7);
  if (!RoomCodeSchema.safeParse(code).success) return null;
  const room = roomManager.get(code);
  if (room === undefined) return null;
  for (const [playerId, player] of room.players) {
    if (verifyToken(token, player.tokenHash)) {
      return { playerId, isHost: playerId === room.hostPlayerId };
    }
  }
  return null;
}

function rateLimit(limiter: RateLimiter, bucket: string) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const key = `${bucket}:${req.ip}`;
    if (!limiter.take(key)) {
      const retry = limiter.retryAfterSecs(key);
      reply.header('retry-after', String(retry));
      void reply
        .code(429)
        .send(apiError('RATE_LIMITED', 'too many requests', { retryAfterSecs: retry }));
    }
  };
}

export function gameRuntimesRoute(opts: GameRuntimesOptions): FastifyPluginAsync {
  const { roomManager, store, analytics } = opts;
  /** code → live runtime. Created on demand; rehydrated from the store when cold. */
  const runtimes = new Map<string, { fsm: RoomFsm; timers: TimerService }>();

  function persist(code: string, fsm: RoomFsm): void {
    const cp: Checkpoint = {
      code,
      fsmState: fsm.state,
      roundIdx: fsm.roundIdx,
      phaseEndsAt: fsm.phaseEndsAt,
    };
    try {
      store.put(code, cp);
    } catch {
      // Checkpoint failure must never crash a transition mid-party; the next
      // successful put() supersedes it (WAL keeps last-good state durable).
    }
  }

  function getRuntime(code: string): { fsm: RoomFsm; timers: TimerService } | null {
    const existing = runtimes.get(code);
    if (existing !== undefined) return existing;

    // Lazy rehydration (D-B): rebuild FSM from the last checkpoint. Rooms
    // created before any checkpoint get one on demand (ensureRuntime below).
    const snap = store.get(code);
    if (snap === undefined) {
      // Fresh room (exists in RoomManager, never persisted): seed LOBBY.
      if (roomManager.get(code) === undefined) return null;
      const fsm = new RoomFsm({
        code,
        onChange: (change) => {
          armForPhase(code, change.phaseEndsAt);
          persist(code, fsm);
        },
      });
      const timers = new TimerService();
      runtimes.set(code, { fsm, timers });
      persist(code, fsm);
      return { fsm, timers };
    }
    const cp = (snap.state ?? null) as Partial<Checkpoint> | null;
    const initial: FsmState | undefined =
      cp !== null && isFsmState(cp.fsmState) ? cp.fsmState : undefined;
    const fsm = new RoomFsm({
      code,
      ...(initial !== undefined ? { initial } : {}),
      roundIdx: typeof cp?.roundIdx === 'number' ? cp.roundIdx : 0,
      onChange: (change) => {
        armForPhase(code, change.phaseEndsAt);
        persist(code, fsm);
      },
    });
    const timers = new TimerService();
    runtimes.set(code, { fsm, timers });

    // Boot-sweep semantics (D-C): a persisted non-null deadline that is still
    // in the future gets re-armed; one in the past fires immediately through
    // the mutex — exactly like a timer that survived the crash.
    if (cp?.phaseEndsAt != null && isTimedState(fsm.state)) {
      timers.arm(`phase:${code}`, cp.phaseEndsAt, () => {
        void fsm.dispatch('TIMER_EXPIRED').catch(() => {});
      });
    }
    return { fsm, timers };
  }

  function isFsmState(s: unknown): s is FsmState {
    return (
      typeof s === 'string' &&
      [
        'LOBBY',
        'CATEGORY',
        'SCENARIO',
        'SONG_SELECTION',
        'LOCKED',
        'PLAYBACK',
        'AI_JUDGING',
        'RESULTS',
        'LEADERBOARD',
        'GAME_OVER',
      ].includes(s)
    );
  }

  function isTimedState(s: string): boolean {
    return s === 'SCENARIO' || s === 'SONG_SELECTION';
  }

  function armForPhase(code: string, phaseEndsAt: number | null): void {
    const rt = runtimes.get(code);
    if (rt === undefined) return;
    const key = `phase:${code}`;
    if (phaseEndsAt !== null && isTimedState(rt.fsm.state)) {
      rt.timers.arm(key, phaseEndsAt, () => {
        void rt.fsm.dispatch('TIMER_EXPIRED').catch(() => {});
      });
    } else {
      rt.timers.disarm(key);
    }
  }

  async function dispatchAsHost(
    code: string,
    event: FsmEvent,
    payload?: TransitionPayload,
  ): Promise<{ ok: true } | { ok: false; status: number; body: ReturnType<typeof apiError> }> {
    const rt = getRuntime(code);
    if (rt === null) {
      return { ok: false, status: 404, body: apiError('ROOM_NOT_FOUND', 'no such room') };
    }
    try {
      await rt.fsm.dispatch(event, payload);
      return { ok: true };
    } catch (err) {
      if (err instanceof IllegalTransitionError) {
        return {
          ok: false,
          status: 409,
          body: apiError('INVALID_ACTION', `cannot ${event.toLowerCase()} from ${rt.fsm.state}`),
        };
      }
      throw err;
    }
  }

  return async (app: FastifyInstance): Promise<void> => {
    /**
     * Host controls (TDD §5): every mutation dispatches through the per-room
     * mutex; role derived ONLY from the Bearer token server-side.
     */
    app.post<{
      Params: { code: string; action: string };
      Body: { category?: unknown; final?: unknown };
    }>(
      '/rooms/:code/host/:action',
      { preHandler: rateLimit(hostActionLimiter, 'host') },
      async (req, reply) => {
        const auth = authenticate(roomManager, req.params.code, req);
        if (auth === null) {
          return reply
            .code(401)
            .send(apiError('NOT_AUTHENTICATED', 'valid session token required'));
        }
        if (!auth.isHost) {
          return reply.code(403).send(apiError('NOT_HOST', 'only the host can do that'));
        }
        const action = req.params.action;
        let result: Awaited<ReturnType<typeof dispatchAsHost>>;
        switch (action) {
          case 'start_game':
            result = await dispatchAsHost(req.params.code, 'START_GAME');
            break;
          case 'skip_phase':
            result = await dispatchAsHost(req.params.code, 'SKIP_PHASE');
            break;
          case 'begin_playback':
            result = await dispatchAsHost(req.params.code, 'BEGIN_PLAYBACK');
            break;
          case 'advance_reveal':
            result = await dispatchAsHost(req.params.code, 'ADVANCE_REVEAL', {
              final: req.body?.final === true,
            });
            break;
          case 'next_round':
            result = await dispatchAsHost(req.params.code, 'NEXT_ROUND');
            break;
          case 'finish_game':
            result = await dispatchAsHost(req.params.code, 'FINISH_GAME');
            break;
          case 'pick_category': {
            const category =
              typeof req.body?.category === 'string' ? req.body.category.trim().slice(0, 80) : '';
            if (category === '') {
              return reply.code(400).send(apiError('INVALID_ACTION', 'category required'));
            }
            result = await dispatchAsHost(req.params.code, 'PICK_CATEGORY', { category });
            break;
          }
          default:
            return reply.code(400).send(apiError('INVALID_ACTION', `unknown action '${action}'`));
        }
        if (!result.ok) {
          return reply.code(result.status).send(result.body);
        }
        analytics.emit({ type: 'round_completed', roomId: req.params.code, durationMs: 0 });
        return reply.send({ ok: true as const, data: { done: true } });
      },
    );

    /**
     * Reclaim (TDD §4 edge rules): a disconnected player reclaims their old
     * identity with a fresh token; the OLD token's hash is replaced so the
     * stale session dies. Name becomes reusable only after disconnect.
     */
    app.post<{ Params: { code: string }; Body: { nickname?: unknown } }>(
      '/rooms/:code/reclaim',
      { preHandler: rateLimit(reclaimLimiter, 'reclaim') },
      async (req, reply) => {
        const nickname = typeof req.body?.nickname === 'string' ? req.body.nickname.trim() : '';
        if (nickname === '') {
          return reply.code(400).send(apiError('INVALID_NICKNAME', 'nickname required'));
        }
        const room = roomManager.get(req.params.code);
        if (room === undefined) {
          return reply.code(404).send(apiError('ROOM_NOT_FOUND', 'no such room'));
        }
        for (const [playerId, player] of room.players) {
          if (player.nickname.toLowerCase() === nickname.toLowerCase()) {
            if (player.connected) {
              return reply.code(409).send(apiError('NAME_TAKEN', 'that player is still connected'));
            }
            const { mintToken, hashToken } = await import('../core/tokens.js');
            const playerToken = mintToken();
            player.tokenHash = hashToken(playerToken); // invalidates the old session
            player.connected = true;
            return reply.send({ ok: true as const, data: { playerToken, playerId, nickname } });
          }
        }
        return reply.code(404).send(apiError('ROOM_NOT_FOUND', 'no such nickname to reclaim'));
      },
    );

    // Phase-state snapshot for the WS hub seam + dev dashboard (read-only).
    app.get<{ Params: { code: string } }>('/rooms/:code/game-state', async (req, reply) => {
      const rt = getRuntime(req.params.code);
      if (rt === null) {
        return reply.code(404).send(apiError('ROOM_NOT_FOUND', 'no such room'));
      }
      return reply.send({
        ok: true as const,
        data: {
          state: rt.fsm.state,
          roundIdx: rt.fsm.roundIdx,
          phaseEndsAt: rt.fsm.phaseEndsAt,
        },
      });
    });
  };
}
