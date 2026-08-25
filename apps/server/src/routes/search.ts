/**
 * Search proxy (Phase 3): GET /api/v1/search?q= → MusicProvider.search().
 *
 * Contract (task spec):
 *   - Bearer-auth ANY room member (the request carries no room code, so the
 *     presented session token is resolved against every room's member hashes).
 *   - Rate-limited 60/min per IP (protects the upstream provider quota).
 *   - Results capped at limit=10 (Spotify hard-rejects >10; TDD §4 probes).
 *   - Response envelope: {ok,data:{tracks:[Track…]}} (@aux/shared shapes).
 */
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { apiError } from '@aux/shared';
import type { Analytics } from '../core/analytics.js';
import { createRateLimiter, type RateLimiter } from '../core/rate-limit.js';
import type { RoomManager } from '../core/room-manager.js';
import { hashToken } from '../core/tokens.js';
import { MusicProviderError } from '../providers/music-provider.js';

export const SEARCH_LIMIT_MAX = 10;
const QUERY_MAX = 120;

export interface SearchRouteOptions {
  provider: import('../providers/music-provider.js').MusicProvider;
  /** Used when the primary provider fails w/ TOKEN_EXPIRED (host not OAuthed). */
  fallback?: import('../providers/music-provider.js').MusicProvider;
  roomManager: RoomManager;
  analytics?: Analytics;
}

const searchLimiter: RateLimiter = createRateLimiter({ windowMs: 60_000, max: 60 });

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

/** Resolve a Bearer session token to a room membership (any role). */
function resolveMember(
  roomManager: RoomManager,
  req: FastifyRequest,
): { code: string; playerId: string } | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  const tokenHash = hashToken(header.slice(7));
  return roomManager.findMemberByTokenHash(tokenHash) ?? null;
}

export function searchRoute(opts: SearchRouteOptions): FastifyPluginAsync {
  const { provider, roomManager } = opts;
  return async (app: FastifyInstance): Promise<void> => {
    app.get<{ Querystring: { q?: unknown; limit?: unknown } }>(
      '/search',
      { preHandler: rateLimit(searchLimiter, 'search') },
      async (req, reply) => {
        const auth = resolveMember(roomManager, req);
        if (auth === null) {
          return reply
            .code(401)
            .send(apiError('NOT_AUTHENTICATED', 'valid session token required'));
        }

        const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, QUERY_MAX) : '';
        if (q === '') {
          return reply.code(400).send(apiError('INVALID_ACTION', 'query parameter q required'));
        }
        const rawLimit = Number(req.query.limit);
        const limit =
          Number.isFinite(rawLimit) && rawLimit >= 1
            ? Math.min(Math.floor(rawLimit), SEARCH_LIMIT_MAX)
            : SEARCH_LIMIT_MAX;

        try {
          const tracks = await provider.search(q, limit);
          return reply.send({ ok: true as const, data: { tracks } });
        } catch (err) {
          if (err instanceof MusicProviderError) {
            // No live host session (or stale token): degrade to the fallback
            // catalog instead of breaking song-picking (owner condition: the
            // party must never dead-end on provider state).
            if (err.code === 'TOKEN_EXPIRED' && opts.fallback !== undefined) {
              try {
                const tracks = await opts.fallback.search(q, limit);
                return reply.send({ ok: true as const, data: { tracks } });
              } catch {
                // fall through to normal error mapping
              }
            }
            if (err.code === 'RATE_LIMITED') {
              const retry = err.retryAfterSecs ?? 30;
              reply.header('retry-after', String(retry));
              return reply.code(429).send(
                apiError('RATE_LIMITED', 'music provider is rate limiting us', {
                  retryAfterSecs: retry,
                }),
              );
            }
            opts.analytics?.emit({
              type: 'provider_failure',
              roomId: auth.code,
              op: 'search',
            });
            return reply
              .code(502)
              .send(apiError('INTERNAL', `music provider unavailable (${err.code})`));
          }
          throw err;
        }
      },
    );
  };
}
