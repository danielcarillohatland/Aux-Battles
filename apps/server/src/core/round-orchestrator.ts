/**
 * RoundOrchestrator — Phase 3 runtime binding (AUX-006, TDD §7/D-E).
 *
 * Binds the per-room RoomFsm instances owned by game-runtimes.ts to everything
 * that has to HAPPEN when the machine moves:
 *
 *  - FSM-backed WS snapshots: replaces the hardcoded LOBBY builder. State,
 *    roundIdx and phaseEndsAt come straight from the live RoomFsm; real
 *    submissionsCount / you.hasSubmitted come from the submission engine via
 *    the narrow SubmissionStoreView seam (implemented by core/submissions.ts).
 *  - Playback mode selection (D-E): 'api' ONLY when a live Spotify session AND
 *    an active device exist — then the whole shuffled round queue goes out in
 *    ONE startPlayback call (TDD §7); otherwise 'manual', broadcast via
 *    snapshot so clients render song cards and the host drives taps.
 *  - QUEUE_DONE detection: API mode polls verify-don't-drive (5 s cadence) and
 *    fires QUEUE_DONE when playback leaves the queue past its last track (or a
 *    hard duration cap trips). Manual mode ends via the host's `queue_done`
 *    action.
 *  - Placeholder judge handoff (Phase 4 lands the real judge): entering
 *    AI_JUDGING arms the phase deadline; expiry logs and immediately dispatches
 *    JUDGEMENT_STORED so the flow reaches RESULTS/LEADERBOARD end-to-end today.
 */
import { randomInt } from 'node:crypto';
import type { FsmState, PlaybackMode, Snapshot } from '@aux/shared';
import { AI_JUDGING_TIMEOUT_MS } from '@aux/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { RoomManager } from './room-manager.js';
import { TimerService } from './timers.js';
import { RoomFsm } from '../fsm/engine.js';
import type { FsmChange } from '../fsm/types.js';
import type { WsHub, WsViewer } from '../ws/types.js';
import type { MusicProvider } from '../providers/music-provider.js';
import type { StoredSubmission } from './submissions.js';
import { fallbackJudge, type JudgeService, type JudgedEntry } from '../judge/judge-service.js';

/**
 * Read-only view of the submission engine (core/submissions.ts implements this
 * exactly). Keyed by composite round identity `${code}:${roundIdx}`. Count-only
 * externally — anonymity (D-D) lives in the implementation, not here.
 */
export interface SubmissionStoreView {
  count(roundId: string): number;
  hasSubmitted(roundId: string, playerId: string): boolean;
  list(roundId: string): StoredSubmission[];
}

/** Liveness probe over the OAuth token store (EncryptedSpotifyTokenStore fits). */
export interface LiveSessionProbe {
  getAccessToken(): Promise<string | null>;
}

/**
 * Structural verify-don't-drive seam (TDD §7): implemented by SpotifyProvider
 * but NOT part of the core MusicProvider contract — orchestrators that lack it
 * simply never enter api mode.
 */
export interface PlaybackStateProbe {
  getPlaybackState(): Promise<{
    isPlaying: boolean;
    progressMs: number | null;
    trackId: string | null;
    deviceId: string | null;
  } | null>;
}

export interface RoundOrchestratorOptions {
  roomManager: RoomManager;
  /** Attached right after initWsHub at the composition root (or in tests). */
  wsHub?: WsHub | undefined;
  log?: FastifyBaseLogger | undefined;
  /** Read view of core/submissions.ts; counts degrade to 0/false when absent. */
  submissions?: SubmissionStoreView | undefined;
  /** Verify-poll cadence override (tests inject small values). */
  pollMs?: number | undefined;
  judge?: JudgeService | undefined;
}

export interface OrchestratorPayload {
  version: 1;
  category?: string;
  scenario?: string;
  queue?: StoredSubmission[];
  playbackIndex?: number;
  playbackMode?: PlaybackMode;
  results?: JudgedEntry[];
  revealIndex?: number;
  leaderboard?: Array<{
    playerId: string;
    nickname: string;
    totalScore: number;
    wins: number;
  }>;
}

/** Verify-don't-drive cadence (TDD §7: 5–10 s). */
const QUEUE_POLL_MS = 5_000;
/** Hard cap beyond the queue's total duration before QUEUE_DONE fires anyway. */
const QUEUE_GRACE_MS = 45_000;
/** Consecutive failed/null playback polls before falling back to manual (D-E grace). */
const DEVICE_LOSS_STRIKES = 3;

export function roundIdOf(code: string, roundIdx: number): string {
  return `${code}:${roundIdx}`;
}

/** Track id → playable URI (search results carry bare ids; stores may too). */
function trackUri(id: string): string {
  return id.startsWith('spotify:') ? id : `spotify:track:${id}`;
}

/** Fisher–Yates over a copy; unbiased indices via crypto.randomInt. */
export function shuffled<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    const a = out[i] as T;
    const b = out[j] as T;
    out[i] = b;
    out[j] = a;
  }
  return out;
}

interface QueueWatch {
  ids: Set<string>;
  totalMs: number;
  startedAt: number;
  misses: number;
  sawQueueTrack: boolean;
  timer: NodeJS.Timeout;
  poller?: PlaybackStateProbe;
}

export interface RoomPlaybackBinding {
  provider: MusicProvider;
  sessionProbe: LiveSessionProbe;
}

export class RoundOrchestrator {
  onChanged: ((code: string) => void) | null = null;
  private hub: WsHub | undefined;
  private provider: MusicProvider | undefined;
  private probe: LiveSessionProbe | undefined;
  private stateProbe: PlaybackStateProbe | undefined;
  private playbackFactory: ((code: string) => RoomPlaybackBinding) | undefined;

  /** code → live FSM (registered by game-runtimes at creation/rehydration). */
  private readonly fsms = new Map<string, RoomFsm>();
  /** Cached D-E mode per room; sync-readable by the snapshot builder. */
  private readonly playbackModes = new Map<string, PlaybackMode>();
  private readonly categories = new Map<string, string>();
  private readonly scenarios = new Map<string, string>();
  private readonly queues = new Map<string, StoredSubmission[]>();
  private readonly playbackIndexes = new Map<string, number>();
  private readonly results = new Map<string, JudgedEntry[]>();
  private readonly revealIndexes = new Map<string, number>();
  private readonly judging = new Set<string>();
  private readonly leaderboard = new Map<
    string,
    Map<string, { playerId: string; nickname: string; totalScore: number; wins: number }>
  >();
  private readonly watches = new Map<string, QueueWatch>();
  private readonly timers = new TimerService();

  constructor(private readonly opts: RoundOrchestratorOptions) {
    this.hub = opts.wsHub;
  }

  private checkpoint(code: string): void {
    try {
      this.onChanged?.(code);
    } catch {
      // Persistence is best-effort; gameplay remains authoritative in memory.
    }
  }

  /** Composition-root wiring once the WS hub exists. */
  attachHub(wsHub: WsHub): void {
    this.hub = wsHub;
  }

  /**
   * Enable L0 API playback. Called only when Spotify env exists: the provider
   * drives the ONE startPlayback-per-round call; the probe decides liveness.
   */
  setPlayback(provider: MusicProvider, sessionProbe: LiveSessionProbe): void {
    this.provider = provider;
    this.probe = sessionProbe;
    // SpotifyProvider implements the poll; FakeProvider doesn't need it (manual).
    if ('getPlaybackState' in provider) {
      this.stateProbe = provider as unknown as PlaybackStateProbe;
    }
  }

  /** Production binding: each room resolves its own host token/provider. */
  setPlaybackFactory(factory: (code: string) => RoomPlaybackBinding): void {
    this.playbackFactory = factory;
  }

  /** Attach/replace the submission read view (wired late at the composition root). */
  setSubmissions(store: SubmissionStoreView | undefined): void {
    this.opts.submissions = store;
  }

  serialize(code: string): OrchestratorPayload {
    const payload: OrchestratorPayload = { version: 1 };
    const category = this.categories.get(code);
    const queue = this.queues.get(code);
    const scenario = this.scenarios.get(code);
    const playbackIndex = this.playbackIndexes.get(code);
    const playbackMode = this.playbackModes.get(code);
    const results = this.results.get(code);
    const revealIndex = this.revealIndexes.get(code);
    const leaderboard = this.leaderboard.get(code);
    if (category !== undefined) payload.category = category;
    if (scenario !== undefined) payload.scenario = scenario;
    if (queue !== undefined) payload.queue = queue;
    if (playbackIndex !== undefined) payload.playbackIndex = playbackIndex;
    if (playbackMode !== undefined) payload.playbackMode = playbackMode;
    if (results !== undefined) payload.results = results;
    if (revealIndex !== undefined) payload.revealIndex = revealIndex;
    if (leaderboard !== undefined) payload.leaderboard = [...leaderboard.values()];
    return payload;
  }

  hydrate(code: string, payload: OrchestratorPayload | null | undefined): void {
    if (payload?.version !== 1) return;
    if (payload.category !== undefined) this.categories.set(code, payload.category);
    if (payload.scenario !== undefined) this.scenarios.set(code, payload.scenario);
    if (payload.queue !== undefined) this.queues.set(code, payload.queue);
    if (payload.playbackIndex !== undefined) this.playbackIndexes.set(code, payload.playbackIndex);
    if (payload.playbackMode !== undefined) this.playbackModes.set(code, payload.playbackMode);
    if (payload.results !== undefined) this.results.set(code, payload.results);
    if (payload.revealIndex !== undefined) this.revealIndexes.set(code, payload.revealIndex);
    if (payload.leaderboard !== undefined) {
      this.leaderboard.set(
        code,
        new Map(payload.leaderboard.map((entry) => [entry.playerId, entry])),
      );
    }
  }

  // ── Runtime registry (fed by game-runtimes.ts) ──────────────────────────────

  /** Register a room's FSM; re-arms the fallback-judge deadline after rehydration. */
  register(code: string, fsm: RoomFsm): void {
    this.fsms.set(code, fsm);
    if (fsm.state === 'AI_JUDGING' && fsm.phaseEndsAt !== null) {
      this.armJudgeTimer(code, fsm.phaseEndsAt);
    }
  }

  forget(code: string): void {
    this.fsms.delete(code);
    this.playbackModes.delete(code);
    this.categories.delete(code);
    this.scenarios.delete(code);
    this.queues.delete(code);
    this.playbackIndexes.delete(code);
    this.results.delete(code);
    this.revealIndexes.delete(code);
    this.judging.delete(code);
    this.leaderboard.delete(code);
    this.stopQueueWatch(code);
    this.timers.disarm(`judge:${code}`);
  }

  // ── FSM side effects ────────────────────────────────────────────────────────

  /**
   * Awaited inside the FSM's onChange hook (after persist/timer arming), so
   * broadcast ordering stays deterministic; async follow-ups are fire-and-
   * forget and never block the mutex.
   */
  onTransition(change: FsmChange): void {
    if (change.event === 'PICK_CATEGORY' && change.payload?.category !== undefined) {
      this.categories.set(change.code, change.payload.category);
      this.scenarios.set(
        change.code,
        `You get one song to define “${change.payload.category}” for the whole room. What do you play?`,
      );
    }
    if (change.event === 'NEXT_ROUND') {
      this.queues.delete(change.code);
      this.playbackIndexes.delete(change.code);
      this.results.delete(change.code);
      this.revealIndexes.delete(change.code);
    }
    if (change.from === 'RESULTS' && change.event === 'ADVANCE_REVEAL') {
      const total = this.results.get(change.code)?.length ?? 0;
      this.revealIndexes.set(
        change.code,
        Math.min(total, (this.revealIndexes.get(change.code) ?? 0) + 1),
      );
    }

    switch (change.to) {
      case 'PLAYBACK':
        void this.enterPlayback(change.code);
        break;
      case 'AI_JUDGING':
        this.armJudgeTimer(change.code, change.phaseEndsAt ?? Date.now() + AI_JUDGING_TIMEOUT_MS);
        void this.startJudging(change.code);
        break;
      default:
        break;
    }
    if (change.from === 'AI_JUDGING') this.timers.disarm(`judge:${change.code}`);

    this.checkpoint(change.code);
    this.broadcast(change.code);
  }

  // ── Snapshot building (the AUX-006 replacement) ─────────────────────────────

  /**
   * FSM-backed, per-viewer snapshot. Falls back to LOBBY-shaped truth from
   * RoomManager when the room has no live runtime yet — same shape either way,
   * so clients never special-case.
   */
  buildSnapshot(code: string, viewer: WsViewer): Snapshot | null {
    const room = this.opts.roomManager.get(code);
    if (room === undefined) return null;

    const fsm = this.fsms.get(code);
    const state: FsmState = fsm?.state ?? 'LOBBY';
    const roundIdx = fsm?.roundIdx ?? 0;
    const roundId = roundIdOf(code, roundIdx);
    const subs = this.opts.submissions;
    const allResults = this.results.get(code) ?? [];
    const visibleResultCount =
      state === 'RESULTS' ? (this.revealIndexes.get(code) ?? 0) : allResults.length;

    return {
      roomCode: code,
      state,
      roundIdx,
      phaseEndsAt: fsm?.phaseEndsAt ?? null,
      playbackMode: this.playbackModes.get(code) ?? 'manual',
      players: [...room.players.entries()]
        .filter(([id]) => id !== room.hostPlayerId)
        .map(([, p]) => ({ nickname: p.nickname, connected: p.connected })),
      submissionsCount: subs?.count(roundId) ?? 0,
      category: this.categories.get(code) ?? null,
      scenario: this.scenarios.get(code) ?? null,
      queue: (this.queues.get(code) ?? []).map((submission) => submission.track),
      playbackIndex: this.playbackIndexes.get(code) ?? 0,
      results: allResults.slice(0, visibleResultCount).map((result) => ({
        rank: result.rank,
        score: result.score,
        explanation: result.explanation,
        track: result.track,
        owner: room.players.get(result.playerId)?.nickname ?? 'Mystery DJ',
        chicken: result.chicken,
      })),
      resultCount: allResults.length,
      revealIndex: visibleResultCount,
      leaderboard: [...(this.leaderboard.get(code)?.values() ?? [])].sort(
        (a, b) => b.totalScore - a.totalScore || b.wins - a.wins,
      ),
      you: {
        role: viewer.role,
        hasSubmitted: subs?.hasSubmitted(roundId, viewer.playerId) ?? false,
        nickname: viewer.nickname,
      },
    };
  }

  // ── Playback orchestration (LOCKED → PLAYBACK, TDD §7/D-E) ─────────────────

  /**
   * L0/L4 selection: ONE startPlayback with the full shuffled queue when a live
   * Spotify session AND an active device exist; otherwise manual mode (song
   * cards, host-driven taps). Every failure path degrades to manual — never to
   * an error page mid-party.
   */
  private async enterPlayback(code: string): Promise<void> {
    const fsm = this.fsms.get(code);
    if (fsm === undefined || fsm.state !== 'PLAYBACK') return;

    const subs = shuffled(this.opts.submissions?.list(roundIdOf(code, fsm.roundIdx)) ?? []);
    this.queues.set(code, subs);
    this.playbackIndexes.set(code, 0);
    const uris = subs.map((s) => trackUri(s.track.id));
    const binding = this.playbackFactory?.(code);
    const provider = binding?.provider ?? this.provider;
    const probe = binding?.sessionProbe ?? this.probe;
    const poller =
      provider !== undefined && 'getPlaybackState' in provider
        ? (provider as unknown as PlaybackStateProbe)
        : this.stateProbe;

    let mode: PlaybackMode = 'manual';
    if (provider !== undefined && (await this.hasLiveSession(probe)) && uris.length > 0) {
      const device = await provider.getActiveDevice().catch(() => null);
      if (device !== null) {
        try {
          await provider.startPlayback({ uris, deviceId: device.id });
          mode = 'api';
          this.startQueueWatch(
            code,
            subs.map((s) => s.track.id),
            poller,
          );
        } catch (err) {
          this.opts.log?.warn({ code, err }, 'startPlayback failed — manual playback fallback');
        }
      } else {
        this.opts.log?.info({ code }, 'no active Spotify device — manual playback mode');
      }
    }

    this.playbackModes.set(code, mode);
    this.checkpoint(code);
    this.broadcast(code);
  }

  /** Host-driven L4 progression. Ownership stays server-side and anonymous. */
  async manualNext(code: string): Promise<'advanced' | 'done' | 'invalid'> {
    const fsm = this.fsms.get(code);
    if (fsm === undefined || fsm.state !== 'PLAYBACK') return 'invalid';
    const queue = this.queues.get(code) ?? [];
    const current = this.playbackIndexes.get(code) ?? 0;
    if (queue.length === 0 || current >= queue.length - 1) {
      await this.dispatchQuietly(fsm, 'QUEUE_DONE');
      return 'done';
    }
    this.playbackIndexes.set(code, current + 1);
    this.checkpoint(code);
    this.broadcast(code);
    return 'advanced';
  }

  private async hasLiveSession(probe: LiveSessionProbe | undefined): Promise<boolean> {
    if (probe === undefined) return false;
    try {
      return (await probe.getAccessToken()) !== null;
    } catch {
      return false;
    }
  }

  private startQueueWatch(code: string, trackIds: string[], poller?: PlaybackStateProbe): void {
    this.stopQueueWatch(code);
    // Total queue duration from stored submissions; durationMs is optional per
    // Track, so unknown entries fall back to a conservative per-track estimate.
    const DEFAULT_TRACK_MS = 210_000;
    const subs =
      this.opts.submissions?.list(roundIdOf(code, this.fsms.get(code)?.roundIdx ?? 0)) ?? [];
    let totalMs = 0;
    for (const s of subs) {
      totalMs += typeof s.track.durationMs === 'number' ? s.track.durationMs : DEFAULT_TRACK_MS;
    }
    if (subs.length === 0) totalMs = DEFAULT_TRACK_MS * trackIds.length;

    const watch: QueueWatch = {
      ids: new Set(trackIds),
      totalMs,
      startedAt: Date.now(),
      misses: 0,
      sawQueueTrack: false,
      ...(poller !== undefined ? { poller } : {}),
      timer: setInterval(() => void this.pollQueue(code), this.opts.pollMs ?? QUEUE_POLL_MS),
    };
    watch.timer.unref();
    this.watches.set(code, watch);
  }

  private stopQueueWatch(code: string): void {
    const w = this.watches.get(code);
    if (w === undefined) return;
    clearInterval(w.timer);
    this.watches.delete(code);
  }

  /**
   * Verify-don't-drive poll: never issues player commands. QUEUE_DONE fires
   * when playback leaves the queued tracks after the last one was seen, or the
   * hard cap trips; repeated dead polls trip the device-loss grace into manual.
   */
  private async pollQueue(code: string): Promise<void> {
    const watch = this.watches.get(code);
    const fsm = this.fsms.get(code);
    if (watch === undefined || fsm === undefined || fsm.state !== 'PLAYBACK') {
      this.stopQueueWatch(code);
      return;
    }
    const poller = watch.poller;
    if (poller === undefined) {
      this.stopQueueWatch(code);
      return;
    }

    const state = await poller.getPlaybackState().catch(() => null);
    if (state === null || !state.isPlaying) {
      watch.misses += 1;
      if (watch.misses >= DEVICE_LOSS_STRIKES) {
        this.opts.log?.warn({ code }, 'playback lost mid-round — manual fallback');
        this.stopQueueWatch(code);
        this.playbackModes.set(code, 'manual');
        this.broadcast(code);
      }
      return;
    }
    watch.misses = 0;

    if (state.trackId !== null && watch.ids.has(state.trackId)) {
      watch.sawQueueTrack = true;
      return;
    }
    const pastQueue =
      state.trackId !== null && !watch.ids.has(state.trackId) && watch.sawQueueTrack;
    const capped = Date.now() - watch.startedAt > watch.totalMs + QUEUE_GRACE_MS;
    if (pastQueue || capped) {
      this.stopQueueWatch(code);
      await this.dispatchQuietly(fsm, 'QUEUE_DONE');
    }
  }

  // ── Batched judging + leaderboard ──────────────────────────────────────────

  private armJudgeTimer(code: string, deadline: number): void {
    this.timers.arm(`judge:${code}`, deadline, () => void this.finishWithFallback(code));
  }

  /**
   * The AI_JUDGING 20 s timeout delegates here (controller callback, TDD §8):
   * run the configured judge (which owns deterministic fallback), then dispatch
   * JUDGEMENT_STORED so RESULTS/LEADERBOARD remain reachable on provider failure.
   */
  private async startJudging(code: string): Promise<void> {
    const fsm = this.fsms.get(code);
    if (fsm === undefined || fsm.state !== 'AI_JUDGING') return;
    const roundId = roundIdOf(code, fsm.roundIdx);
    if (this.judging.has(roundId) || this.results.has(code)) return;
    this.judging.add(roundId);
    const entries = (this.opts.submissions?.list(roundId) ?? []).map((submission) => ({
      playerId: submission.playerId,
      track: submission.track,
      chicken: submission.chicken,
    }));
    const scenario = this.scenarios.get(code) ?? 'the perfect song for this chaotic moment';
    const judged =
      this.opts.judge === undefined
        ? fallbackJudge(scenario, entries)
        : await this.opts.judge.judge(scenario, entries);
    await this.storeJudgement(code, roundId, judged);
  }

  private async finishWithFallback(code: string): Promise<void> {
    const fsm = this.fsms.get(code);
    if (fsm === undefined || fsm.state !== 'AI_JUDGING') return;
    const roundId = roundIdOf(code, fsm.roundIdx);
    const entries = (this.opts.submissions?.list(roundId) ?? []).map((submission) => ({
      playerId: submission.playerId,
      track: submission.track,
      chicken: submission.chicken,
    }));
    const judged = fallbackJudge(this.scenarios.get(code) ?? '', entries);
    await this.storeJudgement(code, roundId, judged);
  }

  private async storeJudgement(
    code: string,
    roundId: string,
    judged: JudgedEntry[],
  ): Promise<void> {
    const fsm = this.fsms.get(code);
    if (fsm === undefined || fsm.state !== 'AI_JUDGING' || this.results.has(code)) return;
    const worstFirst = [...judged].sort((a, b) => b.rank - a.rank);
    this.results.set(code, worstFirst);
    this.revealIndexes.set(code, 0);
    const room = this.opts.roomManager.get(code);
    let board = this.leaderboard.get(code);
    if (board === undefined) {
      board = new Map();
      this.leaderboard.set(code, board);
    }
    for (const result of judged) {
      const current = board.get(result.playerId) ?? {
        playerId: result.playerId,
        nickname: room?.players.get(result.playerId)?.nickname ?? 'Mystery DJ',
        totalScore: 0,
        wins: 0,
      };
      current.totalScore += result.score;
      if (result.rank === 1) current.wins += 1;
      board.set(result.playerId, current);
    }
    this.judging.delete(roundId);
    this.checkpoint(code);
    this.timers.disarm(`judge:${code}`);
    await this.dispatchQuietly(fsm, 'JUDGEMENT_STORED');
  }

  /** Illegal-transition races (host advanced meanwhile) are swallowed by design. */
  private async dispatchQuietly(
    fsm: RoomFsm,
    event: Parameters<RoomFsm['dispatch']>[0],
  ): Promise<void> {
    try {
      await fsm.dispatch(event);
    } catch {
      // Someone else moved the machine first; the newer transition wins.
    }
  }

  private broadcast(code: string): void {
    this.hub?.broadcastStateChange(code);
  }
}
