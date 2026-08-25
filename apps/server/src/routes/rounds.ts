/**
 * Phase 3 round routes (TDD §4-§6): anonymous song submissions.
 *
 * Controller-owned plugin — exported for the composition root to register
 * alongside game-runtimesRoute. This file deliberately does NOT import or edit
 * game-runtimes.ts: every runtime capability it needs arrives as injected
 * seams (getRoomPhase / dispatchAllSubmitted / broadcastSubmissionCount), so
 * wiring stays in index.ts and this module stays unit-testable.
 *
 * Rules implemented:
 * - POST /rounds/:id/submissions with Bearer player auth (:id = `${code}:${roundIdx}`).
 *   Convenience alias POST /rooms/:code/rounds/:roundIdx/submissions.
 * - Accepted only while the room FSM is in SONG_SELECTION and :idx is the live round.
 * - ONE song per player per round → 409 ALREADY_SUBMITTED on a different retry.
 * - clientMsgId idempotency → replay returns the original 200 result.
 * - Track validated against the shared SubmissionRequestSchema (@aux/shared).
 * - Broadcasts are COUNT-ONLY via callback hook — never who (anonymity, D-D).
 * - Quorum early-fire: count === connected players → ALL_SUBMITTED through the
 *   controller's FSM-mutex dispatcher.
 */
import { RoomCodeSchema, SubmissionRequestSchema, apiError } from '@aux/shared';
import type { FsmState } from '@aux/shared';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { RoomManager } from '../core/room-manager.js';
import { AlreadySubmittedError, SubmissionStore } from '../core/submissions.js';
import { createRateLimiter } from '../core/rate-limit.js';
import { verifyToken } from '../core/tokens.js';

export interface RoomPhase {
  state: FsmState;
  roundIdx: number;
}

export interface RoundsRouteOptions {
  roomManager: RoomManager;
  submissions: SubmissionStore;
  /**
   * Seam into the per-room runtime (game-runtimes owns the FSM): current state
   * + roundIdx, or null when no runtime exists for the code.
   */
  getRoomPhase(code: string): RoomPhase | null;
  /** Quorum dispatch through the per-room FSM mutex; returns false if rejected. */
  dispatchAllSubmitted?(code: string): Promise<boolean>;
  /** Count-only anonymity-safe broadcast (maps to `submission_received`). */
  broadcastSubmissionCount?(code: string, count: number): void;
}

const submissionLimiter = createRateLimiter({ windowMs: 60_000, max: 120 });

/** Extract + verify a Bearer session token against the room's players
 *  (same pattern as game-runtimes.ts authenticate — kept local on purpose). */
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

/** Split the composite round id `${code}:${roundIdx}`; null when malformed. */
export function parseRoundId(id: string): { code: string; roundIdx: number } | null {
  const cut = id.lastIndexOf(':');
  if (cut <= 0) return null;
  const code = id.slice(0, cut);
  const roundIdx = Number(id.slice(cut + 1));
  if (!Number.isInteger(roundIdx) || roundIdx < 0) return null;
  if (!RoomCodeSchema.safeParse(code).success) return null;
  return { code, roundIdx };
}

export function roundsRoute(opts: RoundsRouteOptions): FastifyPluginAsync {
  const { roomManager, submissions } = opts;

  async function handleSubmit(
    code: string,
    roundIdx: number,
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const auth = authenticate(roomManager, code, req);
    if (auth === null) {
      return reply.code(401).send(apiError('NOT_AUTHENTICATED', 'valid session token required'));
    }
    const parsed = SubmissionRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send(apiError('INVALID_ACTION', 'clientMsgId and track required'));
    }

    // State gate: submissions only during SONG_SELECTION of the LIVE round.
    const phase = opts.getRoomPhase(code);
    if (phase === null) {
      return reply.code(404).send(apiError('ROOM_NOT_FOUND', 'no such room'));
    }
    if (phase.state !== 'SONG_SELECTION' || phase.roundIdx !== roundIdx) {
      return reply
        .code(409)
        .send(apiError('INVALID_ACTION', `submissions closed (state=${phase.state})`));
    }

    const player = roomManager.get(code)?.players.get(auth.playerId);
    if (player === undefined || !player.connected) {
      return reply.code(401).send(apiError('NOT_AUTHENTICATED', 'player is not connected'));
    }

    try {
      const result = submissions.submit({
        code,
        roundIdx,
        playerId: auth.playerId,
        clientMsgId: parsed.data.clientMsgId,
        track: parsed.data.track,
      });

      if (result.status === 'stored') {
        // Anonymity: count only — the payload NEVER names the submitter.
        opts.broadcastSubmissionCount?.(code, result.count);

        // Quorum early-fire (TDD §4): everyone connected has submitted →
        // dispatch through the FSM mutex. Rejections (e.g. a racing timer)
        // are non-fatal; LOCKED either way.
        const room = roomManager.get(code);
        const connected =
          room === undefined ? 0 : [...room.players.values()].filter((p) => p.connected).length;
        if (opts.dispatchAllSubmitted !== undefined && result.count >= connected && connected > 0) {
          await opts.dispatchAllSubmitted(code);
        }
      }

      return reply.send({
        ok: true as const,
        data: {
          count: result.count,
          replayed: result.status === 'replayed',
          hasSubmitted: true,
        },
      });
    } catch (err) {
      if (err instanceof AlreadySubmittedError) {
        return reply.code(409).send(apiError('ALREADY_SUBMITTED', 'one song per player per round'));
      }
      throw err;
    }
  }

  return async (app: FastifyInstance): Promise<void> => {
    // Primary endpoint (TDD §5): composite round identity `${code}:${roundIdx}`.
    app.post<{ Params: { id: string } }>(
      '/rounds/:id/submissions',
      {
        preHandler: async (req, reply) => {
          const key = `submissions:${req.ip}`;
          if (!submissionLimiter.take(key)) {
            void reply.code(429).send(apiError('RATE_LIMITED', 'too many requests'));
          }
        },
      },
      async (req, reply) => {
        const target = parseRoundId(req.params.id);
        if (target === null) {
          return reply.code(400).send(apiError('INVALID_CODE', 'malformed round id'));
        }
        return handleSubmit(target.code, target.roundIdx, req, reply);
      },
    );

    // Convenience alias keyed off the room's live round — clients read roundIdx
    // from their snapshot, but most callers just know the room code.
    app.post<{ Params: { code: string; roundIdx: string } }>(
      '/rooms/:code/rounds/:roundIdx/submissions',
      {
        preHandler: async (req, reply) => {
          const key = `submissions:${req.ip}`;
          if (!submissionLimiter.take(key)) {
            void reply.code(429).send(apiError('RATE_LIMITED', 'too many requests'));
          }
        },
      },
      async (req, reply) => {
        const roundIdx = Number(req.params.roundIdx);
        if (!Number.isInteger(roundIdx) || roundIdx < 0) {
          return reply.code(400).send(apiError('INVALID_ACTION', 'bad round index'));
        }
        return handleSubmit(req.params.code, roundIdx, req, reply);
      },
    );
  };
}

/**
 * Timer-expiry path (TDD §4 chicken 🐔): called by the controller when
 * TIMER_EXPIRED fires in SONG_SELECTION. Assigns a random popular party track
 * (hardcoded 20-track list) to every CONNECTED player who did not submit,
 * marks them CHICKEN, fires the store's checkpoint hook, and returns a
 * count-only summary. Safe to call for any room state — it is purely additive
 * to the submission store and never advances the FSM itself.
 */
export function submitRandomForMissing(
  code: string,
  roundId: string,
  deps: { roomManager: RoomManager; submissions: SubmissionStore },
): { filledCount: number; totalSubmissions: number } {
  const target = parseRoundId(roundId);
  if (target === null || target.code !== code) {
    return { filledCount: 0, totalSubmissions: deps.submissions.count(roundId) };
  }
  const room = deps.roomManager.get(code);
  if (room === undefined)
    return { filledCount: 0, totalSubmissions: deps.submissions.count(roundId) };
  const connected = [...room.players.keys()].filter(
    (id) => room.players.get(id)?.connected === true,
  );
  const filled = deps.submissions.fillChickens(code, target.roundIdx, connected);
  return { filledCount: filled.length, totalSubmissions: deps.submissions.count(roundId) };
}
