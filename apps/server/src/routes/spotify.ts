/**
 * Spotify OAuth routes (Phase 2.5 spike — D-014, TDD §7):
 *   POST /api/v1/rooms/:code/spotify/login → authenticated authorize URL
 *   GET /api/v1/spotify/callback  → validate state, exchange code, encrypt &
 *                                   store tokens under a host session cookie,
 *                                   render "connected ✓"
 * Composition root wires { oauth, states, tokens } — this file stays glue only.
 */
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
  devMode?: boolean;
  secureCookies?: boolean;
  /**
   * Where the OAuth callback sends the host's browser after "connected ✓".
   * Dev: the Vite origin (the API server has no fresh frontend). Prod:
   * omitted → same-origin `/host.html` served by this process.
   */
  frontendOrigin?: string | undefined;
  authorizeHost(code: string, token: string): boolean;
}

const CONNECTED_HTML = (returnUrl: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>AUX BATTLES</title></head><body style="font-family:system-ui;display:grid;place-items:center;min-height:90vh"><main style="text-align:center"><h1>connected ✓</h1><p>Spotify is ready for this room.</p><p><a href="${returnUrl}" style="display:inline-block;margin-top:1rem;padding:.75rem 1.5rem;border-radius:12px;background:#7c3aed;color:#fff;text-decoration:none;font-weight:600">Return to AUX BATTLES</a></p><script>setTimeout(function(){location.href=${JSON.stringify(returnUrl)}},1500)</script></main></body></html>`;

function sessionCookie(sessionToken: string, secure: boolean): string {
  // Host-session lifetime ≈ token store lifetime; HttpOnly + SameSite=Lax is
  // enough for a same-site callback flow (no third-party context).
  const maxAge = 60 * 60 * 24 * 14;
  return `${HOST_SESSION_COOKIE}=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
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
    const pendingRooms = new Map<string, { roomCode: string; timer: NodeJS.Timeout }>();
    const discardPending = (state: string): string | undefined => {
      const pending = pendingRooms.get(state);
      if (pending === undefined) return undefined;
      clearTimeout(pending.timer);
      pendingRooms.delete(state);
      return pending.roomCode;
    };
    app.addHook('onClose', () => {
      for (const pending of pendingRooms.values()) clearTimeout(pending.timer);
      pendingRooms.clear();
    });

    const authenticate = (code: string, req: FastifyRequest): boolean => {
      const header = req.headers.authorization;
      return (
        typeof header === 'string' &&
        header.startsWith('Bearer ') &&
        opts.authorizeHost(code, header.slice(7))
      );
    };

    app.post<{ Params: { code: string } }>('/rooms/:code/spotify/login', async (req, reply) => {
      if (!authenticate(req.params.code, req)) {
        return reply.code(403).send(apiError('NOT_HOST', 'only the room host can connect Spotify'));
      }
      const { state, challenge } = opts.states.create();
      const timer = setTimeout(() => pendingRooms.delete(state), 10 * 60 * 1000);
      timer.unref();
      pendingRooms.set(state, { roomCode: req.params.code, timer });
      return reply.send({
        ok: true as const,
        data: { authorizeUrl: opts.oauth.authorizeUrl(challenge, state) },
      });
    });

    app.get<{ Params: { code: string } }>('/rooms/:code/spotify/status', async (req, reply) => {
      if (!authenticate(req.params.code, req)) {
        return reply.code(403).send(apiError('NOT_HOST', 'only the room host can inspect Spotify'));
      }
      const connected = (await opts.tokens.load(`room:${req.params.code}`)) !== null;
      return reply.send({ ok: true as const, data: { connected } });
    });

    app.get<{ Querystring: Record<string, string> }>(
      '/spotify/callback',
      async (req: FastifyRequest<{ Querystring: Record<string, string> }>, reply) => {
        const code = req.query.code;
        const state = req.query.state;
        if (req.query.error === 'access_denied' || typeof state !== 'string') {
          if (typeof state === 'string') discardPending(state);
          return reply.code(400).send(apiError('INVALID_CODE', 'oauth state missing or denied'));
        }
        // One-time consume: replayed/unknown/expired states all fail identically.
        const verifier = opts.states.consume(state);
        const roomCode = discardPending(state);
        if (verifier === null || roomCode === undefined || typeof code !== 'string') {
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

        // Room-bound ciphertext prevents one room from driving another host's
        // device. Plaintext exists only inside the token boundary.
        await opts.tokens.save(`room:${roomCode}`, {
          accessToken: exchanged.accessToken,
          refreshToken: exchanged.refreshToken,
          expiresAt: exchanged.expiresAt,
          scope: exchanged.scope,
          spotifyUserId: user.id,
        });

        void reply.header('set-cookie', sessionCookie(roomCode, opts.secureCookies === true));
        // Return the host to the app that started the flow: the Vite origin in
        // dev (fresh frontend lives there, not on this API server), same-origin
        // host.html in production. Room code rides along so the host app's
        // localStorage session reattaches to THIS room.
        const returnUrl = opts.frontendOrigin
          ? `${opts.frontendOrigin.replace(/\/$/, '')}/host.html?room=${encodeURIComponent(roomCode)}`
          : '/host.html';
        void reply.type('text/html; charset=utf-8').code(200).send(CONNECTED_HTML(returnUrl));
      },
    );

    // DEV-ONLY (D-011 doctrine): hands the caller's own access token back to
    // them, gated on a valid session cookie. Lets spike probes exercise the
    // real token path without printing or persisting secrets anywhere.
    if (opts.devMode === true)
      app.get('/spotify/debug-token', async (req: FastifyRequest, reply: FastifyReply) => {
        const session = readHostSession(req);
        if (session === null) {
          return reply
            .code(401)
            .send(apiError('NOT_AUTHENTICATED', 'host session cookie required'));
        }
        const tokens = await opts.tokens.load(`room:${session}`);
        if (tokens === null) {
          return reply
            .code(404)
            .send(apiError('ROOM_NOT_FOUND', 'no Spotify session for that room'));
        }
        return reply.send({ ok: true as const, data: { accessToken: tokens.accessToken } });
      });
  };
}
