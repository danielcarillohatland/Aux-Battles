import { z } from 'zod';
import { apiError, RoomCodeSchema, type FsmState } from '@aux/shared';
import type { FastifyPluginAsync } from 'fastify';
import type { RoomManager } from '../core/room-manager.js';
import { createRateLimiter } from '../core/rate-limit.js';
import { verifyToken } from '../core/tokens.js';
import { ReportConflictError, type SqliteSupportStore } from '../core/support-store.js';

const ReportBody = z
  .object({
    clientReportId: z.string().uuid(),
    kind: z.enum(['nickname', 'defense']),
    targetNickname: z.string().trim().min(1).max(24),
    roundIdx: z.number().int().min(0).max(4).optional(),
    details: z.string().trim().max(1000).default(''),
    alsoBlock: z.boolean().default(false),
  })
  .strict();
export interface ReportsRouteOptions {
  roomManager: RoomManager;
  store: SqliteSupportStore;
  getRoomPhase(code: string): { state: FsmState; roundIdx: number } | null;
  readDefense(code: string, roundIdx: number, playerId: string): string | null;
  onBlocked?(code: string): void;
}

export function reportsRoute(options: ReportsRouteOptions): FastifyPluginAsync {
  const playerLimiter = createRateLimiter({ windowMs: 3_600_000, max: 8 });
  const ipLimiter = createRateLimiter({ windowMs: 3_600_000, max: 40 });
  return async (app) => {
    app.post<{ Params: { code: string } }>(
      '/rooms/:code/reports',
      { bodyLimit: 8_192 },
      async (request, reply) => {
        reply.header('cache-control', 'private, no-store');
        const code = request.params.code;
        const room = RoomCodeSchema.safeParse(code).success
          ? options.roomManager.get(code)
          : undefined;
        const token = request.headers.authorization?.startsWith('Bearer ')
          ? request.headers.authorization.slice(7)
          : '';
        const reporter =
          token && room
            ? [...room.players.entries()].find(([, player]) => verifyToken(token, player.tokenHash))
            : undefined;
        if (!room || !reporter)
          return reply
            .code(401)
            .send(apiError('NOT_AUTHENTICATED', 'Join this room before reporting content.'));
        const parsed = ReportBody.safeParse(request.body);
        if (!parsed.success)
          return reply
            .code(400)
            .send(
              apiError(
                'INVALID_ACTION',
                'Choose a player and report type. Keep details under 1,000 characters.',
              ),
            );
        const body = parsed.data;
        const targets = [...room.players.entries()].filter(
          ([, player]) => player.nickname === body.targetNickname,
        );
        if (targets.length !== 1)
          return reply
            .code(409)
            .send(
              apiError(
                'INVALID_ACTION',
                'This player could not be identified. Contact support with the room code.',
              ),
            );
        const target = targets[0]!;
        if (target[0] === reporter[0])
          return reply
            .code(400)
            .send(apiError('INVALID_ACTION', 'Choose another player to report.'));
        let capturedContent = target[1].nickname;
        let roundIdx: number | null = null;
        if (body.kind === 'defense') {
          const phase = options.getRoomPhase(code);
          if (
            body.roundIdx === undefined ||
            !phase ||
            !['RESULTS', 'LEADERBOARD', 'GAME_OVER'].includes(phase.state) ||
            body.roundIdx > phase.roundIdx
          )
            return reply
              .code(409)
              .send(
                apiError(
                  'INVALID_ACTION',
                  'Song defenses can be reported after their round is revealed.',
                ),
              );
          const defense = options.readDefense(code, body.roundIdx, target[0]);
          if (!defense?.trim())
            return reply
              .code(404)
              .send(apiError('INVALID_ACTION', 'This player has no defense in that round.'));
          capturedContent = defense;
          roundIdx = body.roundIdx;
        }
        const roomKey = `${code}:${room.createdAt}`;
        const playerKey = `${roomKey}:${reporter[0]}`;
        if (!playerLimiter.take(playerKey) || !ipLimiter.take(request.ip)) {
          const retryAfterSecs = Math.max(
            playerLimiter.retryAfterSecs(playerKey),
            ipLimiter.retryAfterSecs(request.ip),
          );
          reply.header('retry-after', String(retryAfterSecs));
          return reply
            .code(429)
            .send(
              apiError(
                'RATE_LIMITED',
                'Too many reports. Please contact support if you need more help.',
                { retryAfterSecs },
              ),
            );
        }
        try {
          const saved = options.store.saveReport({
            roomKey,
            reporterId: reporter[0],
            targetPlayerId: target[0],
            clientReportId: body.clientReportId,
            kind: body.kind,
            roundIdx,
            capturedContent,
            details: body.details,
            alsoBlock: body.alsoBlock,
          });
          if (body.alsoBlock) options.onBlocked?.(code);
          return reply
            .code(saved.created ? 201 : 200)
            .send({ ok: true, data: { reportId: saved.id, hiddenInRoom: body.alsoBlock } });
        } catch (error) {
          if (error instanceof ReportConflictError)
            return reply
              .code(409)
              .send(
                apiError(
                  'INVALID_ACTION',
                  'That report reference was already used. Start a new report.',
                ),
              );
          return reply
            .code(503)
            .send(
              apiError(
                'INTERNAL',
                'Your report could not be saved. Please try again or contact support.',
              ),
            );
        }
      },
    );
  };
}
