/**
 * Room REST routes (TDD §5, wire contract — immutable):
 *   POST /rooms                {} → {ok,data:{code,hostToken,playerId}}
 *   POST /rooms/:code/join     {nickname} → {ok,data:{playerToken,playerId,nickname}}
 *                              | 409 NAME_TAKEN | 404 ROOM_NOT_FOUND
 *   GET  /rooms/:code/snapshot → {ok,data:{roomCode,players,hostNickname}} | 404 ROOM_NOT_FOUND
 *                              with Bearer: the member's full live Snapshot (polling
 *                              fallback when WebSockets fail) | 401 NOT_AUTHENTICATED
 * Errors use the shared envelope + stable code enum. Per-IP rate limits are
 * fastify preHandler hooks (TDD §10 item 5); over-limit → 429 RATE_LIMITED
 * with a Retry-After header.
 */
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { CreateRoomRequestSchema, NicknameSchema, RoomCodeSchema, apiError } from '@aux/shared';
import type { Analytics } from '../core/analytics.js';
import { createRateLimiter, type RateLimiter } from '../core/rate-limit.js';
import {
  JoinClosedError,
  NameTakenError,
  RoomManager,
  RoomNotFoundError,
} from '../core/room-manager.js';
import { verifyToken } from '../core/tokens.js';
import type { WsHub } from '../ws/types.js';
import { OPEN_AI_ACCOUNT_ID, type SqliteBillingLedger } from '../billing/ledger.js';

export interface RoomsRouteOptions {
  roomManager: RoomManager;
  analytics: Analytics;
  wsHub?: WsHub;
  billing?: SqliteBillingLedger;
  /** True when anyone may host a free AI room (`AUX_AI_ACCESS=open` with a configured model). */
  openAi?: () => boolean;
}

// Per-IP budgets (task contract): create 10/h, join 30/10min, snapshot 60/min.
const createLimiter = createRateLimiter({ windowMs: 3_600_000, max: 10 });
const joinLimiter = createRateLimiter({ windowMs: 600_000, max: 30 });
const snapshotLimiter = createRateLimiter({ windowMs: 60_000, max: 60 });
// Authenticated polling is keyed per member: phones on one Wi-Fi share a public IP.
const memberSnapshotLimiter = createRateLimiter({ windowMs: 60_000, max: 40 });

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

export function roomsRoute(opts: RoomsRouteOptions): FastifyPluginAsync {
  const { roomManager, analytics } = opts;
  return async (app: FastifyInstance): Promise<void> => {
    app.post('/rooms', { preHandler: rateLimit(createLimiter, 'create') }, async (_req, reply) => {
      // Contract body is exactly {}; strict-schema mismatch is a client bug.
      const request = CreateRoomRequestSchema.safeParse(_req.body ?? {});
      if (!request.success) {
        return reply
          .code(400)
          .send(apiError('INVALID_CODE', 'expected {} or {"judge":"ai"|"crowd"}'));
      }
      const authorization = _req.headers.authorization;
      const account = authorization?.startsWith('Bearer ')
        ? opts.billing?.authorizeSession(authorization.slice(7))
        : null;
      if (authorization && !account) {
        return reply
          .code(401)
          .send(apiError('NOT_AUTHENTICATED', 'Sign in again to host an AI game.'));
      }
      if (account && account.credits < 1) {
        return reply
          .code(402)
          .send(apiError('INVALID_ACTION', 'Add a game pack or choose crowd judging.'));
      }
      const openAi = !account && request.data.judge !== 'crowd' && opts.openAi?.() === true;
      const { code, hostToken, playerId } = roomManager.createRoom(
        Date.now(),
        account?.id ?? (openAi ? OPEN_AI_ACCOUNT_ID : undefined),
      );
      analytics.emit({ type: 'room_created', roomId: code });
      return reply.code(201).send({ ok: true as const, data: { code, hostToken, playerId } });
    });

    app.post<{ Params: { code: string } }>(
      '/rooms/:code/join',
      { preHandler: rateLimit(joinLimiter, 'join') },
      async (req, reply) => {
        const nickname = NicknameSchema.safeParse(
          (req.body as { nickname?: unknown } | null)?.nickname,
        );
        if (!nickname.success) {
          return reply
            .code(400)
            .send(apiError('INVALID_NICKNAME', 'nickname must be 1-20 characters'));
        }
        try {
          if (
            roomManager.get(req.params.code)?.billingAccountId &&
            (req.body as { aiConsent?: unknown } | null)?.aiConsent !== true
          ) {
            return reply
              .code(400)
              .send(
                apiError(
                  'INVALID_ACTION',
                  'Consent to AI judging is required to join this room. Ask the host for crowd judging if you prefer.',
                ),
              );
          }
          const seated = [...(roomManager.get(req.params.code)?.players.values() ?? [])].filter(
            (player) => player.connected,
          ).length;
          if (seated >= 9) {
            return reply
              .code(409)
              .send(apiError('INVALID_ACTION', 'This room is full (8 players).'));
          }
          const data = roomManager.joinRoom(req.params.code, nickname.data);
          analytics.emit({ type: 'player_joined', roomId: req.params.code });
          // The host is already connected while guests join. Push the updated
          // roster immediately; waiting for the guest's own WS handshake leaves
          // the host stuck at the old count.
          opts.wsHub?.broadcastStateChange(req.params.code);
          return reply.send({ ok: true as const, data });
        } catch (err) {
          if (err instanceof NameTakenError) {
            return reply
              .code(409)
              .send(apiError('NAME_TAKEN', 'nickname already in use in this room'));
          }
          if (err instanceof JoinClosedError) {
            return reply.code(409).send(apiError('INVALID_ACTION', 'joining is closed this round'));
          }
          if (
            err instanceof RoomNotFoundError ||
            !RoomCodeSchema.safeParse(req.params.code).success
          ) {
            return reply.code(404).send(apiError('ROOM_NOT_FOUND', 'no such room'));
          }
          throw err;
        }
      },
    );

    app.get<{ Params: { code: string } }>(
      '/rooms/:code/snapshot',
      {
        preHandler: async (req, reply) => {
          if (req.headers.authorization === undefined)
            await rateLimit(snapshotLimiter, 'snapshot')(req, reply);
        },
      },
      async (req, reply) => {
        if (!RoomCodeSchema.safeParse(req.params.code).success) {
          return reply.code(404).send(apiError('ROOM_NOT_FOUND', 'no such room'));
        }
        const header = req.headers.authorization;
        if (header !== undefined) {
          reply.header('cache-control', 'private, no-store');
          const room = roomManager.get(req.params.code);
          if (room === undefined) {
            return reply.code(404).send(apiError('ROOM_NOT_FOUND', 'no such room'));
          }
          const token = header.startsWith('Bearer ') ? header.slice(7) : '';
          const member = token
            ? [...room.players.entries()].find(([, player]) => verifyToken(token, player.tokenHash))
            : undefined;
          if (member === undefined) {
            return reply.code(401).send(apiError('NOT_AUTHENTICATED', 'invalid session'));
          }
          const key = `${req.params.code}:${member[0]}`;
          if (!memberSnapshotLimiter.take(key)) {
            const retry = memberSnapshotLimiter.retryAfterSecs(key);
            reply.header('retry-after', String(retry));
            return reply
              .code(429)
              .send(apiError('RATE_LIMITED', 'too many requests', { retryAfterSecs: retry }));
          }
          const snapshot = opts.wsHub?.snapshotFor?.(req.params.code, member[0]);
          if (snapshot) return reply.send({ ok: true as const, data: snapshot });
        }
        try {
          return reply.send({ ok: true as const, data: roomManager.snapshot(req.params.code) });
        } catch (err) {
          if (err instanceof RoomNotFoundError) {
            return reply.code(404).send(apiError('ROOM_NOT_FOUND', 'no such room'));
          }
          throw err;
        }
      },
    );
  };
}
