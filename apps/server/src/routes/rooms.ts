/**
 * Room REST routes (TDD §5, wire contract — immutable):
 *   POST /rooms                {} → {ok,data:{code,hostToken,playerId}}
 *   POST /rooms/:code/join     {nickname} → {ok,data:{playerToken,playerId,nickname}}
 *                              | 409 NAME_TAKEN | 404 ROOM_NOT_FOUND
 *   GET  /rooms/:code/snapshot → {ok,data:{roomCode,players,hostNickname}} | 404 ROOM_NOT_FOUND
 * Errors use the shared envelope + stable code enum. Per-IP rate limits are
 * fastify preHandler hooks (TDD §10 item 5); over-limit → 429 RATE_LIMITED
 * with a Retry-After header.
 */
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { CreateRoomRequestSchema, NicknameSchema, RoomCodeSchema, apiError } from '@aux/shared';
import type { Analytics } from '../core/analytics.js';
import { createRateLimiter, type RateLimiter } from '../core/rate-limit.js';
import { NameTakenError, RoomManager, RoomNotFoundError } from '../core/room-manager.js';

export interface RoomsRouteOptions {
  roomManager: RoomManager;
  analytics: Analytics;
}

// Per-IP budgets (task contract): create 10/h, join 30/10min, snapshot 60/min.
const createLimiter = createRateLimiter({ windowMs: 3_600_000, max: 10 });
const joinLimiter = createRateLimiter({ windowMs: 600_000, max: 30 });
const snapshotLimiter = createRateLimiter({ windowMs: 60_000, max: 60 });

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
      if (!CreateRoomRequestSchema.safeParse(_req.body ?? {}).success) {
        return reply.code(400).send(apiError('INVALID_CODE', 'expected an empty JSON object'));
      }
      const { code, hostToken, playerId } = roomManager.createRoom();
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
          const data = roomManager.joinRoom(req.params.code, nickname.data);
          analytics.emit({ type: 'player_joined', roomId: req.params.code });
          return reply.send({ ok: true as const, data });
        } catch (err) {
          if (err instanceof NameTakenError) {
            return reply
              .code(409)
              .send(apiError('NAME_TAKEN', 'nickname already in use in this room'));
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
      { preHandler: rateLimit(snapshotLimiter, 'snapshot') },
      async (req, reply) => {
        if (!RoomCodeSchema.safeParse(req.params.code).success) {
          return reply.code(404).send(apiError('ROOM_NOT_FOUND', 'no such room'));
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
