import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { BillingError } from '../billing/ledger.js';
import { BillingService } from '../billing/service.js';
import { createRateLimiter } from '../core/rate-limit.js';

export function billingRoute({
  service,
  aiAccess = 'account',
}: {
  service: BillingService;
  /** Public: whether hosts get the AI judge free ('open'), via credits ('account'), or not at all. */
  aiAccess?: 'open' | 'account' | 'off';
}): FastifyPluginAsync {
  return async (app) => {
    const limiter = createRateLimiter({ max: 30, windowMs: 60_000 });
    const authLimiter = createRateLimiter({ max: 10, windowMs: 60_000 });
    const limit = async (req: FastifyRequest, reply: FastifyReply) => {
      reply.header('cache-control', 'private, no-store, max-age=0');
      if (!limiter.take(req.ip))
        return reply.code(429).send({
          ok: false,
          error: { code: 'RATE_LIMITED', message: 'Please try again shortly.' },
        });
    };
    const authLimit = async (req: FastifyRequest, reply: FastifyReply) => {
      await limit(req, reply);
      if (reply.sent) return;
      if (!authLimiter.take(req.ip))
        return reply.code(429).send({
          ok: false,
          error: { code: 'RATE_LIMITED', message: 'Please wait before signing in again.' },
        });
    };
    const token = (req: FastifyRequest): string =>
      req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '';
    const failure = (error: unknown, reply: FastifyReply) => {
      if (error instanceof BillingError)
        return reply
          .code(error.statusCode)
          .send({ ok: false, error: { code: error.code, message: error.message } });
      // Do not serialize identity tokens, signed transactions, keys, or database paths.
      app.log.error('billing operation failed');
      return reply.code(503).send({
        ok: false,
        error: {
          code: 'BILLING_UNAVAILABLE',
          message: 'Game credits are temporarily unavailable. Please try again.',
        },
      });
    };
    const textBody = (properties: Record<string, object>, required: string[]) => ({
      body: { type: 'object', additionalProperties: false, required, properties },
    });
    app.get('/billing/config', { preHandler: limit }, async () => ({
      ok: true,
      data: { ...service.publicConfig(), aiAccess },
    }));
    app.post(
      '/billing/challenge',
      { preHandler: authLimit, bodyLimit: 1024 },
      async (_req, reply) => {
        try {
          return { ok: true, data: service.challenge() };
        } catch (e) {
          return failure(e, reply);
        }
      },
    );
    app.post<{ Body: { identityToken: string; challengeId: string; authorizationCode?: string } }>(
      '/billing/apple/session',
      {
        preHandler: authLimit,
        bodyLimit: 20_000,
        schema: textBody(
          {
            identityToken: { type: 'string', minLength: 20, maxLength: 16_384 },
            challengeId: { type: 'string', minLength: 1, maxLength: 100 },
            authorizationCode: { type: 'string', minLength: 1, maxLength: 4096 },
          },
          ['identityToken', 'challengeId'],
        ),
      },
      async (req, reply) => {
        try {
          return {
            ok: true,
            data: await service.signIn(
              req.body.identityToken,
              req.body.challengeId,
              req.body.authorizationCode,
            ),
          };
        } catch (e) {
          return failure(e, reply);
        }
      },
    );
    app.get('/billing/account', { preHandler: limit }, async (req, reply) => {
      try {
        return { ok: true, data: { account: service.requireAccount(token(req)) } };
      } catch (e) {
        return failure(e, reply);
      }
    });
    app.delete('/billing/account', { preHandler: limit }, async (req, reply) => {
      try {
        const account = service.requireAccount(token(req));
        await service.deleteAccount(account);
        return { ok: true, data: { done: true } };
      } catch (e) {
        return failure(e, reply);
      }
    });
    app.delete('/billing/session', { preHandler: limit }, async (req, reply) => {
      try {
        service.ledger.revokeSession(token(req));
        return { ok: true, data: { done: true } };
      } catch (e) {
        return failure(e, reply);
      }
    });
    app.post<{ Body: { signedTransaction: string } }>(
      '/billing/purchases',
      {
        preHandler: limit,
        bodyLimit: 40_000,
        schema: textBody(
          { signedTransaction: { type: 'string', minLength: 20, maxLength: 32_768 } },
          ['signedTransaction'],
        ),
      },
      async (req, reply) => {
        try {
          return {
            ok: true,
            data: await service.purchase(
              service.requireAccount(token(req)),
              req.body.signedTransaction,
            ),
          };
        } catch (e) {
          return failure(e, reply);
        }
      },
    );
    // Apple delivery retries must reach idempotent verification independently of host IP limits.
    app.post<{ Body: { signedPayload: string } }>(
      '/billing/apple/notifications',
      {
        bodyLimit: 100_000,
        schema: textBody({ signedPayload: { type: 'string', minLength: 20, maxLength: 90_000 } }, [
          'signedPayload',
        ]),
      },
      async (req, reply) => {
        try {
          return { ok: true, data: await service.notification(req.body.signedPayload) };
        } catch (e) {
          return failure(e, reply);
        }
      },
    );
  };
}
