/**
 * Spotify OAuth routes (Phase 2.5 spike — D-014, TDD §7):
 *   GET /api/v1/spotify/login     → 302 to Spotify authorize (PKCE + state)
 *   GET /api/v1/spotify/callback  → validate state, exchange code, encrypt &
 *                                   store tokens under a host session cookie,
 *                                   render "connected ✓"
 * Composition root wires { oauth, states, tokens } — this file stays glue only.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { apiError } from '@aux/shared';
import {
  InvalidGrantError,
  PkceStateStore,
  SpotifyOAuth,
  SpotifyOAuthError,
  type SpotifyTokenStore,
  type TokenSet,
  type SpotifyUser,
} from '../providers/spotify/oauth.js';

export const HOST_SESSION_COOKIE = 'aux_host_session';

export interface SpotifyRouteOptions {
  oauth: SpotifyOAuth;
  states: PkceStateStore;
  tokens: SpotifyTokenStore;
}

const CONNECTED_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>AUX BATTLES</title></head><body style="font-family:system-ui;display:grid;place-items:center;min-height:90vh"><main><h1>connected ✓</h1><p>You can close this tab and return to AUX BATTLES.</p></main></body></html>`;

function sessionCookie(sessionToken: string): string {
  // Host-session lifetime ≈ token store lifetime; HttpOnly + SameSite=Lax is
  // enough for a same-site callback flow (no third-party context).
  const maxAge = 60 * 60 * 24 * 14;
  return `${HOST_SESSION_COOKIE}=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

export function readHostSession(req: FastifyRequest): string | null {
  const cookie = req.headers.cookie;
  if (typeof cookie !== 'string') return null;
  for (const part of cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === HOST_SESSION_COOKIE) return rest.join('=');
  }
  return null;
}

export function spotifyRoute(opts: SpotifyRouteOptions): FastifyPluginAsync {
  return async (app: FastifyInstance): Promise<void> => {
    app.get('/spotify/login', async (_req, reply: FastifyReply) => {
      const { state, challenge } = opts.states.create();
      return reply.redirect(opts.oauth.authorizeUrl(challenge, state), 302);
    });

    app.get<{ Querystring: Record<string, string> }>(
      '/spotify/callback',
      async (req: FastifyRequest<{ Querystring: Record<string, string> }>, reply) => {
        const code = req.query.code;
        const state = req.query.state;
        if (req.query.error === 'access_denied' || typeof state !== 'string') {
          return reply.code(400).send(apiError('INVALID_CODE', 'oauth state missing or denied'));
        }
        // One-time consume: replayed/unknown/expired states all fail identically.
        const verifier = opts.states.consume(state);
        if (verifier === null || typeof code !== 'string') {
          return reply.code(400).send(apiError('INVALID_CODE', 'unknown or expired oauth state'));
        }

        let user: SpotifyUser;
        let exchanged: TokenSet;
        try {
          exchanged = await opts.oauth.exchangeCode(code, verifier);
          user = await opts.oauth.me(exchanged.accessToken);
        } catch (err) {
          if (err instanceof InvalidGrantError) {
            return reply
              .code(400)
              .send(apiError('INVALID_CODE', 'spotify rejected the authorization'));
          }
          if (err instanceof SpotifyOAuthError) {
            req.log.warn({ status: err.status }, 'spotify oauth exchange failed');
            return reply.code(502).send(apiError('INTERNAL', 'spotify token exchange failed'));
          }
          throw err;
        }

        // Key the encrypted store by an opaque per-host session token; the host
        // browser holds it in an HttpOnly cookie. Plaintext never leaves here.
        const sessionToken = randomUUID();
        await opts.tokens.save(sessionToken, {
          accessToken: exchanged.accessToken,
          refreshToken: exchanged.refreshToken,
          expiresAt: exchanged.expiresAt,
          scope: exchanged.scope,
          spotifyUserId: user.id,
        });

        void reply.header('set-cookie', sessionCookie(sessionToken));
        void reply.type('text/html; charset=utf-8').code(200).send(CONNECTED_HTML);
      },
    );
  };
}
