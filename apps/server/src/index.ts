/**
 * AUX BATTLES server entrypoint (Phase 0 skeleton).
 * Composition root: config → analytics → (Phase 2) RoomManager/WS hub → routes.
 * Single process owns REST + WS + game state (D-G).
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';
import { loadConfig } from './core/config.js';
import { Analytics, NdjsonAnalyticsSink } from './core/analytics.js';
import { RoomManager, type SerializedRoom } from './core/room-manager.js';
import { healthRoute } from './routes/health.js';
import { devRoute, type DebugState } from './routes/dev.js';
import { roomsRoute } from './routes/rooms.js';
import { OPEN_AI_ACCOUNT_ID, SqliteBillingLedger } from './billing/ledger.js';
import { billingLedgerOptionsFromEnv, createBillingService } from './billing/service.js';
import { billingRoute } from './routes/billing.js';
import { LlmProviderError } from './judge/llm-provider.js';
import { gameRuntimesRoute } from './routes/game-runtimes.js';
import { SqliteRoomStore } from './core/room-store.js';
import { startTtlSweeper } from './core/timers.js';
import { apiError, EMPTY_ROOM_TTL_MS, ROOM_TTL_MS } from '@aux/shared';
import { initWsHub } from './ws/index.js';
import { licensedMusicRoute } from './routes/licensed-music.js';
import { appleMusicRoute } from './routes/apple-music.js';
import { deezerRoute } from './routes/deezer.js';
import { youtubeRoute } from './routes/youtube.js';
import { judgeRoute } from './routes/judge.js';
import { LicensedCatalogProvider } from './providers/licensed-catalog/index.js';
import { AppleMusicCatalogProvider } from './providers/apple-music/index.js';
import { DeezerCatalogProvider } from './providers/deezer/index.js';
import { YouTubeCatalogProvider } from './providers/youtube/index.js';
import { ITunesSongIndex } from './providers/song-index/itunes.js';
import { ManualSongCatalog } from './providers/song-index/manual-catalog.js';
import { OriginalCatalogProvider } from './providers/original-catalog/index.js';
import { CombinedMusicCatalog } from './providers/music-provider.js';
import { hashToken, verifyToken } from './core/tokens.js';
import { searchRoute } from './routes/search.js';
import { SubmissionStore } from './core/submissions.js';
import { ResultsStore } from './core/results.js';
import { roundsRoute } from './routes/rounds.js';
import { RoundOrchestrator } from './core/round-orchestrator.js';
import { OpenRouterProvider } from './judge/openrouter.js';
import { allowedOriginsFromEnv, isAllowedCrossOrigin } from './core/origins.js';
import { SqliteSupportStore } from './core/support-store.js';
import { appConfigRoute, publicAppConfigFromEnv } from './routes/app-config.js';
import { reportsRoute } from './routes/reports.js';

/** Number of trusted reverse proxies in front of the app (0/unset = none). */
export function trustedProxyHops(
  value: string | undefined,
): false | ((address: string, hop: number) => boolean) {
  const text = value?.trim();
  if (!text || text === '0') return false;
  const hops = Number(text);
  if (!Number.isSafeInteger(hops) || hops < 1 || hops > 5) {
    throw new Error('AUX_TRUST_PROXY must be the number of trusted proxy hops (1-5)');
  }
  // Same semantics as proxy-addr's numeric form: trust only the nearest `hops`.
  return (_address, hop) => hop < hops;
}

export async function buildServer(env: NodeJS.ProcessEnv = process.env) {
  // Load .env (gitignored) for local dev — real env vars always win.
  // Anchored to the repo root (src/ → apps/server/src → apps/server → root)
  // because npm workspaces run this file with cwd=apps/server.
  const repoRoot = resolve(fileURLToPath(import.meta.url), '../../../..');
  // Automated tests stay hermetic: a developer's real keys must never reach them.
  const underTest =
    process.env.VITEST !== undefined || (env.NODE_ENV ?? process.env.NODE_ENV) === 'test';
  for (const candidate of underTest ? [] : [process.cwd(), repoRoot]) {
    const envFile = resolve(candidate, '.env');
    if (!existsSync(envFile)) continue;
    for (const [key, value] of Object.entries(parseEnv(readFileSync(envFile, 'utf8')))) {
      if (env[key] === undefined) env[key] = value;
    }
  }
  const cfg = loadConfig(env);
  const log = Fastify({
    logger: { level: cfg.logLevel },
    // A hop count, never `true`: with `true` the client-controlled left-most
    // X-Forwarded-For entry becomes req.ip and every per-IP limit is bypassable.
    trustProxy: trustedProxyHops(env.AUX_TRUST_PROXY),
  });
  const allowedOrigins = allowedOriginsFromEnv(env);
  const relayAncestors = ["'self'", ...allowedOrigins].join(' ');

  // Baseline browser hardening that cannot break third-party players: no MIME
  // sniffing, no referrer leakage of room URLs, and no framing except the
  // YouTube relay page, which native shells and allowed origins embed.
  log.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'strict-origin-when-cross-origin');
    const path = request.url.split('?')[0] ?? '';
    if (path === '/yt-relay.html') {
      reply.header('content-security-policy', `frame-ancestors ${relayAncestors}`);
    } else {
      reply.header('x-frame-options', 'DENY');
      reply.header('content-security-policy', "frame-ancestors 'none'");
    }
    // API responses carry session tokens and live game state: never cache them
    // unless a route opted in explicitly (e.g. public app config).
    if (path.startsWith('/api/') && !reply.hasHeader('cache-control')) {
      reply.header('cache-control', 'no-store');
    }
    return payload;
  });

  // One envelope for unexpected failures; internals and upstream text stay in logs.
  log.setErrorHandler((caught, request, reply) => {
    const error = caught as { statusCode?: unknown; message?: unknown };
    const status =
      typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 600
        ? error.statusCode
        : 500;
    if (status >= 500) {
      request.log.error({ err: caught }, 'request failed');
      return reply
        .code(status)
        .send(apiError('INTERNAL', 'Something went wrong. Please try again.'));
    }
    // Fastify's own 4xx (bad JSON, body too large) are safe to describe.
    return reply
      .code(status)
      .send(
        apiError(
          'INVALID_ACTION',
          typeof error.message === 'string' && error.message
            ? error.message.slice(0, 200)
            : 'Invalid request.',
        ),
      );
  });

  // Native bundles live at Capacitor's local origin while the multiplayer
  // backend stays remote. Keep that bridge narrow; public websites are denied
  // unless their exact origin is added through AUX_ALLOWED_ORIGINS.
  await log.register(fastifyCors, {
    credentials: false,
    origin(origin, callback) {
      callback(null, isAllowedCrossOrigin(origin, allowedOrigins));
    },
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
  if (
    (env.NODE_ENV ?? process.env.NODE_ENV) === 'production' &&
    (!env.AUX_DB_FILE || env.AUX_DB_FILE === ':memory:')
  ) {
    throw new Error(
      'Production requires AUX_DB_FILE on persistent storage for game credits and spending limits.',
    );
  }

  // Phase-2 realtime is initialized before room routes so a successful join
  // can publish its roster mutation to an already-connected host.
  const wsHub = await initWsHub(log, { roomManager, allowedOrigins });
  const billingFile = env.AUX_DB_FILE ?? ':memory:';
  if (billingFile !== ':memory:') mkdirSync(dirname(resolve(billingFile)), { recursive: true });
  // Who may use the AI judge: 'open' = anyone, free, inside the budgets below
  // (portfolio/party deployment); 'account' = signed-in hosts with game credits.
  const aiAccessMode = (env.AUX_AI_ACCESS?.trim() || 'open') as 'open' | 'account';
  if (aiAccessMode !== 'open' && aiAccessMode !== 'account') {
    throw new Error("AUX_AI_ACCESS must be 'open' or 'account'");
  }
  const aiConfigured = !!env.OPENROUTER_API_KEY?.trim() && env.AUX_AI_ENABLED !== '0';
  const aiAccess = aiConfigured ? aiAccessMode : 'off';
  const openAiDailyGames = Number(env.AUX_OPEN_AI_DAILY_GAMES ?? 30);
  if (!Number.isSafeInteger(openAiDailyGames) || openAiDailyGames < 0) {
    throw new Error('AUX_OPEN_AI_DAILY_GAMES must be a whole number');
  }
  const billing = new SqliteBillingLedger(
    billingFile,
    billingLedgerOptionsFromEnv(env, aiAccessMode),
  );
  const billingService = createBillingService(env, billing);
  // Private moderation evidence shares the durable database file.
  const supportStore = new SqliteSupportStore(billingFile);
  await log.register(
    appConfigRoute({ config: publicAppConfigFromEnv(env, { reportsAvailable: true }) }),
    { prefix: '/api/v1' },
  );
  await log.register(billingRoute({ service: billingService, aiAccess }), { prefix: '/api/v1' });
  await log.register(
    roomsRoute({ roomManager, analytics, wsHub, billing, openAi: () => aiAccess === 'open' }),
    { prefix: '/api/v1' },
  );
  const gameKey = (code: string): string =>
    `${code}:${roomManager.get(code)?.createdAt ?? 'missing'}`;

  // Phase-2 persistence (D-B): SQLite WAL checkpoints. ':memory:' in tests.
  const store = new SqliteRoomStore(env.AUX_DB_FILE ?? ':memory:');
  // Rehydrate durable rosters before any runtime/WS authentication occurs.
  for (const code of store.codes()) {
    const checkpoint = store.get(code)?.state as { room?: SerializedRoom | null } | undefined;
    if (checkpoint?.room != null) roomManager.hydrate(code, checkpoint.room);
  }
  const expireRoom = (code: string, reason: string): void => {
    runtimeAccess?.forget(code);
    supportStore.clearRoomBlocks(gameKey(code));
    billing.completeGame(gameKey(code));
    wsHub.closeRoom(code, reason);
    orchestrator.forget(code);
    submissions.clearRoom(code);
    results.clearRoom(code);
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

  // Phase-3 round orchestration (AUX-006): one submission engine + one
  // orchestrator bind the FSMs to snapshots, playback mode (D-E) and the
  // validated batched judge + deterministic fallback.
  const submissions = new SubmissionStore();
  const appleMusicCatalog = AppleMusicCatalogProvider.fromEnv(env);
  // Optional publisher-owned recordings can extend Apple Music. The legacy
  // originals provider is opt-in only for old rooms and automated fixtures.
  const licensedCatalog = LicensedCatalogProvider.fromEnv(env);
  // Deezer previews (D-023): 30-second clips for playtests. Explicit opt-in
  // only (AUX_DEEZER_PREVIEWS=1); YouTube is the product catalog.
  const deezerCatalog = DeezerCatalogProvider.fromEnv(env);
  // YouTube (D-024): commercially usable search + official embedded player on
  // the host screen. Needs a server-side Data API key.
  const youtubeCatalog = YouTubeCatalogProvider.fromEnv(env);
  // Zero-key song gallery (D-027): without a YouTube key the same metadata
  // index still powers search and every pick plays in manual mode.
  const songSearchEnabled =
    env.AUX_SONG_SEARCH?.trim() !== '0' && (env.NODE_ENV ?? process.env.NODE_ENV) !== 'test';
  const manualSongCatalog =
    youtubeCatalog === null && songSearchEnabled
      ? new ManualSongCatalog(
          new ITunesSongIndex(
            env.AUX_YOUTUBE_REGION?.trim() ? { country: env.AUX_YOUTUBE_REGION.trim() } : {},
          ),
        )
      : null;
  const musicCatalog = new CombinedMusicCatalog([
    ...(appleMusicCatalog === null ? [] : [appleMusicCatalog]),
    ...(licensedCatalog === null ? [] : [licensedCatalog]),
    ...(youtubeCatalog === null ? [] : [youtubeCatalog]),
    ...(deezerCatalog === null ? [] : [deezerCatalog]),
    ...(manualSongCatalog === null ? [] : [manualSongCatalog]),
    ...(env.AUX_ENABLE_ORIGINALS === '1' ? [new OriginalCatalogProvider()] : []),
  ]);
  submissions.setChickenTracks(musicCatalog.listTracks());
  // Phase-4 results/leaderboard (TDD §6): judgements persist through the room
  // checkpoint; standings join submissions → playerId and score by rank points.
  const results = new ResultsStore(submissions);
  // Judge vendor (D-012): config-swappable LLM behind judgeTrack. No key →
  // every round is judged by the deterministic hash fallback.
  const llm = OpenRouterProvider.fromEnv(env);
  if (llm === null) {
    log.log.warn('OPENROUTER_API_KEY is not configured; rounds will use crowd voting');
  }
  const attemptMicros = Number(env.AUX_AI_ATTEMPT_MAX_MICROS ?? 10_000);
  if (!Number.isSafeInteger(attemptMicros) || attemptMicros < 1)
    throw new Error('Invalid AUX_AI_ATTEMPT_MAX_MICROS');
  llm?.setAttemptHooks({
    beforeAttempt: (attempt) => {
      if (
        !attempt.roomCode ||
        attempt.roundIdx === undefined ||
        env.AUX_AI_ENABLED === '0' ||
        !billing.canContinueGame(gameKey(attempt.roomCode), attempt.roundIdx + 1)
      ) {
        throw new LlmProviderError('budget_exhausted', 'No active AI game allowance.', false);
      }
      try {
        if (
          !billing.reserveAiAttempt({
            id: attempt.id,
            roomCode: gameKey(attempt.roomCode),
            maxCostMicros: attemptMicros,
          })
        ) {
          throw new Error('Attempt already reserved');
        }
      } catch {
        throw new LlmProviderError(
          'budget_exhausted',
          'The AI spending limit has been reached.',
          false,
        );
      }
    },
    onAttempt: (attempt) => {
      billing.settleAiAttempt(attempt.id, {
        model: attempt.model,
        ...(attempt.promptVersion ? { promptVersion: attempt.promptVersion } : {}),
        status: attempt.status === 'succeeded' ? 'success' : 'failed',
        durationMs: Math.round(attempt.durationMs),
        ...(attempt.errorCode ? { errorCode: attempt.errorCode } : {}),
        ...(!attempt.dispatched ? { costMicros: 0 } : {}),
        ...(attempt.usage?.costUsd !== undefined
          ? { costMicros: Math.ceil(attempt.usage.costUsd * 1_000_000) }
          : {}),
        ...(attempt.usage?.inputTokens !== undefined
          ? { inputTokens: attempt.usage.inputTokens }
          : {}),
        ...(attempt.usage?.outputTokens !== undefined
          ? { outputTokens: attempt.usage.outputTokens }
          : {}),
      });
    },
  });
  const operationsToken = env.AUX_OPERATIONS_TOKEN?.trim();
  if (operationsToken && operationsToken.length < 32)
    throw new Error('AUX_OPERATIONS_TOKEN must contain at least 32 characters.');
  if (operationsToken) {
    log.get('/api/v1/operations/judge', async (req, reply) => {
      reply.header('cache-control', 'private, no-store');
      const supplied = req.headers.authorization?.startsWith('Bearer ')
        ? req.headers.authorization.slice(7)
        : '';
      if (!supplied || !verifyToken(supplied, hashToken(operationsToken))) {
        return reply.code(403).send({
          ok: false,
          error: { code: 'NOT_AUTHENTICATED', message: 'Operator access required.' },
        });
      }
      return {
        ok: true,
        data: {
          budget: billing.getBudget(),
          metrics: billing.getMetrics(),
          provider: llm?.getStatus() ?? null,
        },
      };
    });
  }
  const orchestrator = new RoundOrchestrator({
    roomManager,
    isHidden: (code, viewerId, targetId) =>
      supportStore.isBlocked(gameKey(code), viewerId, targetId),
    wsHub,
    log: log.log,
    submissions,
    results,
    canUseAi: (code, roundIdx) => billing.canContinueGame(gameKey(code), roundIdx + 1),
    onRoundFailure: (code, reason) => {
      // Free rooms have no credit to return; only that round falls back to voting.
      if (roomManager.get(code)?.billingAccountId === OPEN_AI_ACCOUNT_ID) return;
      billing.refundGame(gameKey(code), reason);
    },
    ...(env.AUX_EXCERPT_DURATION_MS !== undefined
      ? {
          excerptDurationMs: Math.max(
            1,
            Number.parseInt(env.AUX_EXCERPT_DURATION_MS, 10) || 30_000,
          ),
        }
      : {}),
    ...(llm !== null ? { llm } : {}),
  });
  orchestrator.setCatalogPlayback(musicCatalog);
  if (youtubeCatalog === null) {
    orchestrator.setManualPlaybackHint(
      'Video playback is not enabled for this room. Use a music link below to play the song.',
    );
  }

  // Phase-2 game runtime wiring (controller integration): FSM + timers +
  // checkpointing + host controls + reclaim + kick, all through the per-room
  // mutex. Every transition flows to the orchestrator for broadcast/effects.
  let runtimeAccess: {
    getRoomPhase(code: string): { state: import('@aux/shared').FsmState; roundIdx: number } | null;
    dispatchAllSubmitted(code: string): Promise<boolean>;
    forget(code: string): void;
  } | null = null;
  await log.register(
    gameRuntimesRoute({
      openAiDailyGames,
      roomManager,
      store,
      analytics,
      wsHub,
      orchestrator,
      submissions,
      billing,
      exposeRuntime: (access) => {
        runtimeAccess = access;
      },
    }),
    {
      prefix: '/api/v1',
    },
  );

  await log.register(
    reportsRoute({
      roomManager,
      store: supportStore,
      getRoomPhase: (code) => runtimeAccess?.getRoomPhase(code) ?? null,
      readDefense: (code, roundIdx, playerId) =>
        submissions
          .list(`${code}:${roundIdx}`)
          .find((submission) => submission.playerId === playerId)?.defense ?? null,
      onBlocked: (code) => wsHub.broadcastStateChange(code),
    }),
    { prefix: '/api/v1' },
  );

  const authorizeHost = (code: string, token: string): boolean => {
    const room = roomManager.get(code);
    const host = room?.players.get(room.hostPlayerId);
    return host !== undefined && verifyToken(token, host.tokenHash);
  };

  await log.register(
    judgeRoute({
      authorizeHost,
      configured: llm !== null && env.AUX_AI_ENABLED !== '0',
      offDuty: (code) => roomManager.get(code)?.aiOffDuty === true,
      roomMode: (code) =>
        roomManager.get(code)?.billingAccountId &&
        billing.getGame(gameKey(code))?.status !== 'refunded'
          ? 'ai'
          : 'crowd',
      ...(llm?.getStatus ? { getStatus: () => llm.getStatus!() } : {}),
    }),
    { prefix: '/api/v1' },
  );

  if (appleMusicCatalog !== null) {
    await log.register(appleMusicRoute({ catalog: appleMusicCatalog, authorizeHost }), {
      prefix: '/api/v1',
    });
    log.log.info('Apple Music catalog and MusicKit playback registered');
  } else if (deezerCatalog === null && youtubeCatalog === null) {
    log.log.warn(
      manualSongCatalog === null
        ? 'no music catalog is configured (AUX_YOUTUBE_API_KEY / AUX_APPLE_MUSIC_DEVELOPER_TOKEN / AUX_DEEZER_PREVIEWS); players enter songs manually'
        : 'AUX_YOUTUBE_API_KEY is not set: song search works, but the host plays picks manually',
    );
  }

  // Always registered so the host lobby can say plainly whether in-game video is on.
  await log.register(youtubeRoute({ authorizeHost, available: youtubeCatalog !== null }), {
    prefix: '/api/v1',
  });
  if (youtubeCatalog !== null) {
    log.log.info('YouTube song search and embedded video playback registered');
  }

  if (deezerCatalog !== null) {
    await log.register(deezerRoute({ catalog: deezerCatalog, authorizeHost }), {
      prefix: '/api/v1',
    });
    log.log.info('Deezer song search and 30-second preview playback registered');
  }

  // Optional publisher-controlled audio with per-track license evidence.
  if (licensedCatalog !== null) {
    await log.register(licensedMusicRoute({ catalog: licensedCatalog, authorizeHost }), {
      prefix: '/api/v1',
    });
    log.log.info(
      { tracks: licensedCatalog.listTracks().length },
      'rights-cleared licensed catalog registered',
    );
  }

  await log.register(
    searchRoute({
      catalog: musicCatalog,
      roomManager,
    }),
    { prefix: '/api/v1' },
  );

  // Phase-3 submissions (TDD §6): idempotent, anonymous, quorum early-fire.
  await log.register(
    roundsRoute({
      roomManager,
      submissions,
      catalog: musicCatalog,
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
        playbackMode: snap?.playbackMode ?? 'catalog',
        phaseEndsAt: snap?.phaseEndsAt ?? null,
      };
    });

  // Production is one deployable: serve the built Solid clients from the
  // same origin as REST/WS. Development still uses Vite when dist is absent.
  const webDist = resolve(repoRoot, 'apps/web/dist');
  if (existsSync(webDist)) {
    await log.register(fastifyStatic, {
      root: webDist,
      wildcard: true,
      // Vite content-hashes /assets bundles: cache them forever, revalidate HTML.
      setHeaders(res, filePath) {
        if (/-[A-Za-z0-9_-]{8}\.(?:js|css)$/.test(filePath)) {
          res.header('cache-control', 'public, max-age=31536000, immutable');
        } else if (filePath.endsWith('.html')) {
          res.header('cache-control', 'no-cache');
        }
      },
    });
    log.get('/', async (_req, reply) => reply.redirect('/host.html'));
  }

  log.addHook('onClose', async () => {
    stopTtlSweeper();
    store.close();
    supportStore.close();
    billing.close();
    await analytics.flush();
  });

  return {
    app: log,
    cfg,
    analytics,
    roomManager,
    wsHub,
    store,
    billing,
    stopTtlSweeper,
    submissions,
    results,
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
  // Background game work runs as fire-and-forget promises; one unexpected
  // rejection must be logged, not take down every room in the process.
  process.on('unhandledRejection', (reason) => {
    app.log.error({ err: reason }, 'unhandled rejection');
  });
  app
    .listen({ port: cfg.port, host: cfg.host })
    .then((addr) => app.log.info(`AUX BATTLES listening on ${addr} (dev=${cfg.devMode})`))
    .catch((err) => {
      app.log.error(err);
      process.exit(1);
    });
}
