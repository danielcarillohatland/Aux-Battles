/**
 * AUX BATTLES server entrypoint (Phase 0 skeleton).
 * Composition root: config → analytics → (Phase 2) RoomManager/WS hub → routes.
 * Single process owns REST + WS + game state (D-G).
 */
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Fastify from 'fastify';
import { loadConfig } from './core/config.js';
import { Analytics, NdjsonAnalyticsSink } from './core/analytics.js';
import { RoomManager } from './core/room-manager.js';
import { healthRoute } from './routes/health.js';
import { devRoute, type DebugState } from './routes/dev.js';
import { roomsRoute } from './routes/rooms.js';

export async function buildServer(env: NodeJS.ProcessEnv = process.env) {
  const cfg = loadConfig(env);
  const log = Fastify({ logger: { level: cfg.logLevel } });

  // Analytics bus (D-010): dev/test default to an NDJSON file under var/.
  const analyticsPath = env.AUX_ANALYTICS_FILE ?? null;
  const sink = new NdjsonAnalyticsSink(analyticsPath);
  if (analyticsPath && analyticsPath !== ':memory:') {
    mkdirSync(dirname(resolve(analyticsPath)), { recursive: true });
  }
  const analytics = new Analytics(sink);
  // Open the NDJSON stream now; without start() every write() is a silent no-op.
  if (analyticsPath && analyticsPath !== ':memory:') {
    sink.start();
  }

  // Phase-0 debug registry — RoomManager replaces the source in Phase 2 (same shape).
  const debug: DebugState = {
    getRooms: () => [],
  };

  await log.register(healthRoute);
  if (cfg.devMode) {
    await log.register(devRoute(debug));
  }

  // Phase-1 room state + REST contract (TDD §5).
  const roomManager = new RoomManager();
  await log.register(roomsRoute({ roomManager, analytics }), { prefix: '/api/v1' });

  return { app: log, cfg, analytics, roomManager };
}

const isMain =
  process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '');
if (isMain) {
  const { app, cfg, analytics } = await buildServer();
  // Graceful shutdown on SIGINT *and* SIGTERM (containers/orchestrators send
  // SIGTERM): flush analytics before the process drops them.
  const shutdown = () => {
    analytics.flush();
    void app.close();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  app
    .listen({ port: cfg.port, host: cfg.host })
    .then((addr) => app.log.info(`AUX BATTLES listening on ${addr} (dev=${cfg.devMode})`))
    .catch((err) => {
      app.log.error(err);
      process.exit(1);
    });
}
