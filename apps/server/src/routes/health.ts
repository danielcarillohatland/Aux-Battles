import type { FastifyInstance } from 'fastify';

export async function healthRoute(app: FastifyInstance): Promise<void> {
  app.get('/healthz', async () => ({
    ok: true as const,
    data: { status: 'ok', version: '0.1.0' },
  }));
}
