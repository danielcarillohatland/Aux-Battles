/** Host-authenticated MusicKit configuration. Audio remains Apple-hosted and DRM protected. */
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { apiError } from '@aux/shared';
import type { AppleMusicCatalogProvider } from '../providers/apple-music/index.js';

export interface AppleMusicRouteOptions {
  catalog: AppleMusicCatalogProvider;
  authorizeHost(code: string, token: string): boolean;
}

export function appleMusicRoute(opts: AppleMusicRouteOptions): FastifyPluginAsync {
  return async (app: FastifyInstance): Promise<void> => {
    const authenticate = (code: string, req: FastifyRequest): boolean => {
      const header = req.headers.authorization;
      return (
        typeof header === 'string' &&
        header.startsWith('Bearer ') &&
        opts.authorizeHost(code, header.slice(7))
      );
    };

    app.get<{ Params: { code: string } }>('/rooms/:code/apple-music/config', async (req, reply) => {
      if (!authenticate(req.params.code, req)) {
        return reply.code(403).send(apiError('NOT_HOST', 'only the room host can play music'));
      }
      void reply.header('cache-control', 'private, no-store, max-age=0');
      return reply.send({
        ok: true as const,
        data: { available: true, ...opts.catalog.webConfiguration() },
      });
    });
  };
}
