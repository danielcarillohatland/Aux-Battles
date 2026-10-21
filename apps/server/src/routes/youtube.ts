/** Host-visible YouTube availability. The Data API key itself never leaves the server. */
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { apiError } from '@aux/shared';

export interface YouTubeRouteOptions {
  authorizeHost(code: string, token: string): boolean;
  /** False when no AUX_YOUTUBE_API_KEY is configured. */
  available: boolean;
}

export function youtubeRoute(opts: YouTubeRouteOptions): FastifyPluginAsync {
  return async (app: FastifyInstance): Promise<void> => {
    const authenticate = (code: string, req: FastifyRequest): boolean => {
      const header = req.headers.authorization;
      return (
        typeof header === 'string' &&
        header.startsWith('Bearer ') &&
        opts.authorizeHost(code, header.slice(7))
      );
    };

    app.get<{ Params: { code: string } }>('/rooms/:code/youtube/status', async (req, reply) => {
      if (!authenticate(req.params.code, req)) {
        return reply.code(403).send(apiError('NOT_HOST', 'only the room host can inspect music'));
      }
      void reply.header('cache-control', 'private, no-store, max-age=0');
      return reply.send({
        ok: true as const,
        data: {
          available: opts.available,
          ...(opts.available ? {} : { reason: 'AUX_YOUTUBE_API_KEY is not set on the server' }),
        },
      });
    });
  };
}
