/**
 * Host-authenticated Deezer preview resolution. The server never proxies or
 * stores the audio: it hands the host a fresh, short-lived CDN clip URL that the
 * browser's <audio> element plays directly.
 */
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { apiError } from '@aux/shared';
import { MusicCatalogError } from '../providers/music-provider.js';
import type { DeezerCatalogProvider } from '../providers/deezer/index.js';

export interface DeezerRouteOptions {
  catalog: DeezerCatalogProvider;
  authorizeHost(code: string, token: string): boolean;
}

export function deezerRoute(opts: DeezerRouteOptions): FastifyPluginAsync {
  return async (app: FastifyInstance): Promise<void> => {
    const authenticate = (code: string, req: FastifyRequest): boolean => {
      const header = req.headers.authorization;
      return (
        typeof header === 'string' &&
        header.startsWith('Bearer ') &&
        opts.authorizeHost(code, header.slice(7))
      );
    };

    app.get<{ Params: { code: string } }>('/rooms/:code/deezer/status', async (req, reply) => {
      if (!authenticate(req.params.code, req)) {
        return reply.code(403).send(apiError('NOT_HOST', 'only the room host can inspect music'));
      }
      void reply.header('cache-control', 'private, no-store, max-age=0');
      return reply.send({ ok: true as const, data: { available: true, previewMs: 30_000 } });
    });

    app.get<{ Params: { code: string; id: string } }>(
      '/rooms/:code/deezer/:id/preview',
      async (req, reply) => {
        if (!authenticate(req.params.code, req)) {
          return reply.code(403).send(apiError('NOT_HOST', 'only the room host can play music'));
        }
        void reply.header('cache-control', 'private, no-store, max-age=0');
        try {
          const preview = await opts.catalog.preview(req.params.id);
          return reply.send({
            ok: true as const,
            data: {
              previewUrl: preview.url,
              expiresAt: preview.expiresAt,
              previewMs: preview.previewMs,
            },
          });
        } catch (error) {
          if (error instanceof MusicCatalogError && error.code === 'TRACK_UNPLAYABLE') {
            return reply.code(404).send(apiError('INVALID_ACTION', 'Deezer preview not found'));
          }
          if (error instanceof MusicCatalogError) {
            return reply.code(503).send(apiError('INTERNAL', 'Deezer is unavailable right now'));
          }
          throw error;
        }
      },
    );
  };
}
