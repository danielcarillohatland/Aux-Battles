/** Authenticated, no-store delivery for publisher-licensed catalog audio. */
import { createReadStream } from 'node:fs';
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { apiError } from '@aux/shared';
import type { LicensedCatalogProvider } from '../providers/licensed-catalog/index.js';

export interface LicensedMusicRouteOptions {
  catalog: LicensedCatalogProvider;
  authorizeHost(code: string, token: string): boolean;
}

export function licensedMusicRoute(opts: LicensedMusicRouteOptions): FastifyPluginAsync {
  return async (app: FastifyInstance): Promise<void> => {
    const authenticate = (code: string, req: FastifyRequest): boolean => {
      const header = req.headers.authorization;
      return (
        typeof header === 'string' &&
        header.startsWith('Bearer ') &&
        opts.authorizeHost(code, header.slice(7))
      );
    };

    app.get<{ Params: { code: string } }>(
      '/rooms/:code/licensed-music/status',
      async (req, reply) => {
        if (!authenticate(req.params.code, req)) {
          return reply.code(403).send(apiError('NOT_HOST', 'only the room host can inspect music'));
        }
        return reply.send({
          ok: true as const,
          data: { available: true, trackCount: opts.catalog.listTracks().length },
        });
      },
    );

    app.get<{ Params: { code: string; id: string } }>(
      '/rooms/:code/licensed-music/:id/audio',
      async (req, reply) => {
        if (!authenticate(req.params.code, req)) {
          return reply.code(403).send(apiError('NOT_HOST', 'only the room host can play music'));
        }
        const asset = opts.catalog.audioAsset(req.params.id);
        if (asset === null) {
          return reply.code(404).send(apiError('INVALID_ACTION', 'licensed track not found'));
        }
        // A host fetches the file into a short-lived object URL. Never expose a
        // static public directory or allow intermediaries to retain the audio.
        void reply.header('cache-control', 'private, no-store, max-age=0');
        void reply.header('content-type', asset.mimeType);
        void reply.header('content-length', String(asset.size));
        void reply.header('x-content-type-options', 'nosniff');
        return reply.send(createReadStream(asset.path));
      },
    );
  };
}
