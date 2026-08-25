/**
 * AUX BATTLES server entrypoint (Phase 0 skeleton).
 * Composition root: config → analytics → (Phase 2) RoomManager/WS hub → routes.
 * Single process owns REST + WS + game state (D-G).
 */
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { loadConfig } from './core/config.js';
import { Analytics, NdjsonAnalyticsSink } from './core/analytics.js';
import { RoomManager } from './core/room-manager.js';
import { healthRoute } from './routes/health.js';
import { devRoute, type DebugState } from './routes/dev.js';
import { roomsRoute } from './routes/rooms.js';
import { gameRuntimesRoute } from './routes/game-runtimes.js';
import { SqliteRoomStore } from './core/room-store.js';
import { startTtlSweeper } from './core/timers.js';
import { ROOM_TTL_MS } from '@aux/shared';
import { initWsHub } from './ws/index.js';
import {
  loadSpotifyEnv,
  PkceStateStore,
  SpotifyOAuth,
  EncryptedSpotifyTokenStore,
  tokenEncryptionKey,
} from './providers/spotify/oauth.js';
import { spotifyRoute } from './routes/spotify.js';

export async function buildServer(env: NodeJS.ProcessEnv = process.env) {
  // Load .env (gitignored) for local dev — real env vars always win.
  // Anchored to the repo root (src/ → apps/server/src → apps/server → root)
  // because npm workspaces run this file with cwd=apps/server.
  const repoRoot = resolve(fileURLToPath(import.meta.url), '../../../..');
  for (const candidate of [process.cwd(), repoRoot]) {
    const envFile = resolve(candidate, '.env');
    if (!existsSync(envFile)) continue;
    for (const line of readFileSync(envFile, 'utf8').split('\n')) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m?.[1] !== undefined && m[2] !== undefined && env[m[1]] === undefined) env[m[1]] = m[2];
    }
  }
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

  // Phase-2 persistence (D-B): SQLite WAL checkpoints. ':memory:' in tests.
  const store = new SqliteRoomStore(env.AUX_DB_FILE ?? ':memory:');
  const stopTtlSweeper = startTtlSweeper(60_000, () => {
    // TTL/cleanup ONLY (D-C) — never a state-advancer.
    for (const code of store.codes()) {
      const cp = store.get(code);
      if (cp !== undefined) {
        const state = cp.state as { phaseEndsAt?: number | null } | null;
        if (state?.phaseEndsAt != null && Date.now() - cp.updatedAt > ROOM_TTL_MS) {
          store.delete(code);
        }
      }
    }
  });

  // Phase-2 game runtime wiring (controller integration): FSM + timers +
  // checkpointing + host controls + reclaim, all through the per-room mutex.
  await log.register(gameRuntimesRoute({ roomManager, store, analytics }), { prefix: '/api/v1' });

  // Phase-2 realtime: read-mostly WS hub (D-D) — tickets, seq frames, heartbeat.
  const wsHub = await initWsHub(log, { roomManager });

  // Phase-2.5 Spotify spike (D-014): OAuth + encrypted token store. Registered
  // ONLY when credentials exist — the game runs fine without them (manual mode).
  const spotifyEnv = loadSpotifyEnv(env);
  if (spotifyEnv) {
    const oauth = new SpotifyOAuth(spotifyEnv);
    const tokenKey = tokenEncryptionKey(env, spotifyEnv.clientSecret);
    await log.register(
      spotifyRoute({
        oauth,
        states: new PkceStateStore(),
        tokens: new EncryptedSpotifyTokenStore({ key: tokenKey, oauth }),
      }),
      { prefix: '/api/v1' },
    );
    log.log.info('Spotify OAuth routes registered (Dev Mode spike)');
  } else {
    log.log.warn('SPOTIFY_* env missing — OAuth disabled, manual playback only');
  }
  wsHub.setSnapshotBuilder((code, viewer) => {
    // Default LOBBY snapshot enriched with live FSM state when a runtime exists.
    const room = roomManager.get(code);
    if (room === undefined) return null;
    return {
      roomCode: code,
      state: 'LOBBY',
      roundIdx: 0,
      phaseEndsAt: null,
      playbackMode: 'manual', // D-E default mode
      players: [...room.players.values()].map((p) => ({
        nickname: p.nickname,
        connected: p.connected,
      })),
      submissionsCount: 0,
      you: { role: viewer.role, hasSubmitted: false, nickname: viewer.nickname },
    };
  });

  return { app: log, cfg, analytics, roomManager, wsHub, store, stopTtlSweeper };
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
