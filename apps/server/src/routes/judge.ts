import type { FastifyPluginAsync } from 'fastify';
import { apiError } from '@aux/shared';

interface JudgeHealth {
  requests: number;
  maxRequests: number;
  lastError?: { code: string } | undefined;
  lastSuccessAt?: string | undefined;
}

export interface JudgeRouteOptions {
  authorizeHost(code: string, token: string): boolean;
  configured: boolean;
  roomMode?(code: string): 'ai' | 'crowd';
  /** True when the free AI allowance ran out as this room's game started. */
  offDuty?(code: string): boolean;
  getStatus?: (() => JudgeHealth) | undefined;
}

const ERROR_MESSAGES: Record<string, string> = {
  auth: 'The AI service rejected its credentials. The round will switch to crowd voting.',
  payment_required: 'The AI service needs credits. The round will switch to crowd voting.',
  budget_exhausted:
    'This server has reached its AI allowance. The round will switch to crowd voting.',
  busy: 'The AI judge is busy. The round may switch to crowd voting.',
  rate_limited: 'The AI service is limiting requests. The round may switch to crowd voting.',
  timeout: 'The AI service took too long. The round will switch to crowd voting.',
};

/** Authenticated, zero-cost diagnostics; never probes the provider or exposes secrets. */
export function judgeRoute(opts: JudgeRouteOptions): FastifyPluginAsync {
  return async (app) => {
    app.get<{ Params: { code: string } }>('/rooms/:code/judge/status', async (req, reply) => {
      const header = req.headers.authorization;
      if (
        typeof header !== 'string' ||
        !header.startsWith('Bearer ') ||
        !opts.authorizeHost(req.params.code, header.slice(7))
      ) {
        return reply
          .code(403)
          .send(apiError('NOT_HOST', 'only the room host can inspect the judge'));
      }
      reply.header('cache-control', 'private, no-store, max-age=0');
      if (opts.offDuty?.(req.params.code)) {
        return {
          ok: true,
          data: {
            state: 'offline',
            message: 'DJ AUX is off duty for today. The room votes instead.',
          },
        };
      }
      if (!opts.configured || opts.roomMode?.(req.params.code) === 'crowd') {
        return {
          ok: true,
          data: {
            state: 'offline',
            message: 'Everyone votes for a song. No AI credit is used.',
          },
        };
      }
      const health = opts.getStatus?.();
      const error =
        health && health.requests >= health.maxRequests
          ? 'budget_exhausted'
          : health?.lastError?.code;
      return {
        ok: true,
        data: {
          state: error ? 'degraded' : health?.lastSuccessAt ? 'ready' : 'configured',
          message: error
            ? (ERROR_MESSAGES[error] ??
              'The AI service could not judge a recent pick. The round switches to crowd voting.')
            : health?.lastSuccessAt
              ? 'AI is responding. Verdicts use song information and your defense, not audio analysis.'
              : 'The first pick will check the connection. AI judges song information and your defense.',
        },
      };
    });
  };
}
