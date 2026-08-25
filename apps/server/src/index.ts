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
import fastifyStatic from '@fastify/static';
import { loadConfig } from './core/config.js';
import { Analytics, NdjsonAnalyticsSink } from './core/analytics.js';
import { RoomManager, type SerializedRoom } from './core/room-manager.js';
import { healthRoute } from './routes/health.js';
import { devRoute, type DebugState } from './routes/dev.js';
import { roomsRoute } from './routes/rooms.js';
import { gameRuntimesRoute } from './routes/game-runtimes.js';
import { SqliteRoomStore } from './core/room-store.js';
import { startTtlSweeper } from './core/timers.js';
import { EMPTY_ROOM_TTL_MS, ROOM_TTL_MS } from '@aux/shared';
import { initWsHub } from './ws/index.js';
import {
  loadSpotifyEnv,
  PkceStateStore,
  SpotifyOAuth,
  EncryptedSpotifyTokenStore,
  tokenEncryptionKey,
} from './providers/spotify/oauth.js';
import { spotifyRoute } from './routes/spotify.js';
import { FakeProvider } from './providers/fake/fake-provider.js';
import {
  SpotifyProvider,
  type SpotifyTokenStore as PlaybackTokenStore,
} from './providers/spotify/index.js';
import type { MusicProvider } from './providers/music-provider.js';
import { searchRoute } from './routes/search.js';
import { SubmissionStore } from './core/submissions.js';
import { roundsRoute } from './routes/rounds.js';
import { RoundOrchestrator } from './core/round-orchestrator.js';
import { JudgeService } from './judge/judge-service.js';
import { OpenRouterProvider } from './judge/openrouter-provider.js';

/**
 * Bridge the two token seams (Phase 2.5 oauth ↔ Phase 3 playback): the OAuth
 * store is session-keyed while SpotifyProvider wants a bare getAccessToken().
 * Single-host MVP: the most recently saved OAuth session IS the host's.
 */
function hostPlaybackTokens(store: EncryptedSpotifyTokenStore): PlaybackTokenStore {
  return {
    async getAccessToken() {
      const session = store.latestSession();
      if (session === null) return null; // host never OAuthed
      const tokens = await store.load(session);
      return tokens?.accessToken ?? null;
    },
  };
}

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
  const log = Fastify({
    logger: { level: cfg.logLevel },
    trustProxy: env.AUX_TRUST_PROXY === '1',
  });

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
  // Rehydrate durable rosters before any runtime/WS authentication occurs.
  for (const code of store.codes()) {
    const checkpoint = store.get(code)?.state as { room?: SerializedRoom | null } | undefined;
    if (checkpoint?.room != null) roomManager.hydrate(code, checkpoint.room);
  }
  const expireRoom = (code: string, reason: string): void => {
    wsHub.closeRoom(code, reason);
    orchestrator.forget(code);
    submissions.clearRoom(code);
    roomManager.delete(code);
    store.delete(code);
  };
  const stopTtlSweeper = startTtlSweeper(60_000, () => {
    // TTL/cleanup ONLY (D-C) — never a state-advancer.
    for (const code of store.codes()) {
      const cp = store.get(code);
      if (cp !== undefined) {
        const room = roomManager.get(code);
        const hardExpired = room !== undefined && Date.now() - room.createdAt >= ROOM_TTL_MS;
        const empty = room === undefined || [...room.players.values()].every((p) => !p.connected);
        const emptyExpired = empty && Date.now() - cp.updatedAt >= EMPTY_ROOM_TTL_MS;
        if (hardExpired || emptyExpired)
          expireRoom(code, hardExpired ? 'room expired' : 'room empty');
      }
    }
  });

  // Phase-2 realtime: read-mostly WS hub (D-D) — tickets, seq frames, heartbeat.
  // Created BEFORE the runtime routes so kick/orchestrator wiring can use it.
  const wsHub = await initWsHub(log, { roomManager });

  // Phase-3 round orchestration (AUX-006): one submission engine + one
  // orchestrator bind the FSMs to snapshots, playback mode (D-E) and the
  // validated batched judge + deterministic fallback.
  const submissions = new SubmissionStore();
  const openRouterKey = env.OPENROUTER_API_KEY?.trim();
  const judge = new JudgeService(
    openRouterKey
      ? new OpenRouterProvider(openRouterKey, env.OPENROUTER_MODEL ?? 'google/gemini-2.0-flash-001')
      : undefined,
    {
      maxCalls: Number(env.AUX_LLM_MAX_CALLS ?? 1_000),
    },
  );
  const orchestrator = new RoundOrchestrator({
    roomManager,
    wsHub,
    log: log.log,
    submissions,
    judge,
  });

  // Phase-2 game runtime wiring (controller integration): FSM + timers +
  // checkpointing + host controls + reclaim + kick, all through the per-room
  // mutex. Every transition flows to the orchestrator for broadcast/effects.
  let runtimeAccess: {
    getRoomPhase(code: string): { state: import('@aux/shared').FsmState; roundIdx: number } | null;
    dispatchAllSubmitted(code: string): Promise<boolean>;
  } | null = null;
  await log.register(
    gameRuntimesRoute({
      roomManager,
      store,
      analytics,
      wsHub,
      orchestrator,
      submissions,
      exposeRuntime: (access) => {
        runtimeAccess = access;
      },
    }),
    {
      prefix: '/api/v1',
    },
  );

  // Phase-2.5 Spotify spike (D-014): OAuth + encrypted token store. Registered
  // ONLY when credentials exist — the game runs fine without them (manual mode).
  // The SAME branch picks the MusicProvider for the Phase-3 search proxy:
  // SpotifyProvider when live, FakeProvider otherwise (deterministic catalog).
  let provider: MusicProvider = new FakeProvider();
  const spotifyEnv = loadSpotifyEnv(env);
  if (spotifyEnv) {
    const oauth = new SpotifyOAuth(spotifyEnv);
    const tokenKey = tokenEncryptionKey(env, spotifyEnv.clientSecret);
    const tokens = new EncryptedSpotifyTokenStore({ key: tokenKey, oauth });
    await log.register(
      spotifyRoute({
        oauth,
        states: new PkceStateStore(),
        tokens,
        devMode: cfg.devMode,
        secureCookies: env.NODE_ENV === 'production',
      }),
      { prefix: '/api/v1' },
    );
    provider = new SpotifyProvider({ tokenStore: hostPlaybackTokens(tokens) });
    // L0 API playback (TDD §7): the same token bridge doubles as the live-
    // session probe — null access token ⇒ manual mode per D-E.
    orchestrator.setPlayback(provider, hostPlaybackTokens(tokens));
    log.log.info('Spotify OAuth routes registered (Dev Mode spike)');
  } else {
    log.log.warn('SPOTIFY_* env missing — OAuth disabled, manual playback only');
  }

  // Search must NEVER 502 just because the host hasn't OAuthed yet (or the
  // access token is stale): fall back to the deterministic FakeProvider
  // catalog so song-picking always works. Live Spotify search resumes as
  // soon as a session exists (provider swapped above).
  const searchFallback = new FakeProvider();
  await log.register(searchRoute({ provider, roomManager, fallback: searchFallback }), {
    prefix: '/api/v1',
  });

  // Phase-3 submissions (TDD §6): idempotent, anonymous, quorum early-fire.
  await log.register(
    roundsRoute({
      roomManager,
      submissions,
      getRoomPhase: (code) => {
        const rt = runtimeAccess?.getRoomPhase(code);
        return rt ?? null;
      },
      dispatchAllSubmitted: async (code) =>
        (await runtimeAccess?.dispatchAllSubmitted(code)) ?? false,
      broadcastSubmissionCount: (code, count) => {
        wsHub.publish(code, { t: 'submission_received', count });
      },
    }),
    { prefix: '/api/v1' },
  );
  // AUX-006: FSM-backed snapshot builder — state/roundIdx/phaseEndsAt from the
  // live RoomFsm, real submission counts, per-viewer `you`, D-E playback mode.
  wsHub.setSnapshotBuilder((code, viewer) => orchestrator.buildSnapshot(code, viewer));
  debug.getRooms = () =>
    roomManager.entries().map(([code, room]) => {
      const phase = runtimeAccess?.getRoomPhase(code);
      const snap = orchestrator.buildSnapshot(code, {
        playerId: room.hostPlayerId,
        role: 'host',
        nickname: room.players.get(room.hostPlayerId)?.nickname ?? null,
      });
      return {
        code,
        state: phase?.state ?? 'LOBBY',
        roundIdx: phase?.roundIdx ?? 0,
        players: room.players.size,
        connectedPlayers: [...room.players.values()].filter((player) => player.connected).length,
        submissionsCount: snap?.submissionsCount ?? 0,
        playbackMode: snap?.playbackMode ?? 'manual',
        phaseEndsAt: snap?.phaseEndsAt ?? null,
      };
    });

  // Production is one deployable: serve the built Solid clients from the
  // same origin as REST/WS. Development still uses Vite when dist is absent.
  const webDist = resolve(repoRoot, 'apps/web/dist');
  if (existsSync(webDist)) {
    await log.register(fastifyStatic, { root: webDist, wildcard: true });
    log.get('/', async (_req, reply) => reply.redirect('/host.html'));
  }

  log.addHook('onClose', async () => {
    stopTtlSweeper();
    store.close();
    await analytics.flush();
  });

  return {
    app: log,
    cfg,
    analytics,
    roomManager,
    wsHub,
    store,
    stopTtlSweeper,
    submissions,
    orchestrator,
  };
}

const isMain =
  process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '');
if (isMain) {
  const { app, cfg } = await buildServer();
  // Graceful shutdown on SIGINT *and* SIGTERM (containers/orchestrators send
  // SIGTERM): flush analytics before the process drops them.
  const shutdown = () => {
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
