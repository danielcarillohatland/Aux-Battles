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
}

export class RoundOrchestrator {
  private hub: WsHub | undefined;
  private provider: MusicProvider | undefined;
  private probe: LiveSessionProbe | undefined;
  private stateProbe: PlaybackStateProbe | undefined;

  /** code → live FSM (registered by game-runtimes at creation/rehydration). */
  private readonly fsms = new Map<string, RoomFsm>();
  /** Cached D-E mode per room; sync-readable by the snapshot builder. */
  private readonly playbackModes = new Map<string, PlaybackMode>();
  private readonly watches = new Map<string, QueueWatch>();
  private readonly timers = new TimerService();

  constructor(private readonly opts: RoundOrchestratorOptions) {
    this.hub = opts.wsHub;
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

  /** Attach/replace the submission read view (wired late at the composition root). */
  setSubmissions(store: SubmissionStoreView | undefined): void {
    this.opts.submissions = store;
  }

  // ── Runtime registry (fed by game-runtimes.ts) ──────────────────────────────

  /** Register a room's FSM; re-arms the placeholder-judge deadline after rehydration. */
  register(code: string, fsm: RoomFsm): void {
    this.fsms.set(code, fsm);
    if (fsm.state === 'AI_JUDGING' && fsm.phaseEndsAt !== null) {
      this.armJudgeTimer(code, fsm.phaseEndsAt);
    }
  }

  forget(code: string): void {
    this.fsms.delete(code);
    this.playbackModes.delete(code);
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
    // Refresh the cached mode opportunistically (sync snapshot reads stay cheap).
    void this.refreshSessionLiveness(change.code);

    switch (change.to) {
      case 'PLAYBACK':
        void this.enterPlayback(change.code);
        break;
      case 'AI_JUDGING':
        this.armJudgeTimer(change.code, change.phaseEndsAt ?? Date.now() + AI_JUDGING_TIMEOUT_MS);
        break;
      default:
        break;
    }
    if (change.from === 'AI_JUDGING') this.timers.disarm(`judge:${change.code}`);

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

    return {
      roomCode: code,
      state,
      roundIdx,
      phaseEndsAt: fsm?.phaseEndsAt ?? null,
      playbackMode: this.playbackModes.get(code) ?? 'manual',
      players: [...room.players.values()].map((p) => ({
        nickname: p.nickname,
        connected: p.connected,
      })),
      submissionsCount: subs?.count(roundId) ?? 0,
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

    const subs = this.opts.submissions?.list(roundIdOf(code, fsm.roundIdx)) ?? [];
    const uris = shuffled(subs.map((s) => trackUri(s.track.id)));

    let mode: PlaybackMode = 'manual';
    if (this.provider !== undefined && (await this.hasLiveSession()) && uris.length > 0) {
      const device = await this.provider.getActiveDevice().catch(() => null);
      if (device !== null) {
        try {
          await this.provider.startPlayback({ uris, deviceId: device.id });
          mode = 'api';
          this.startQueueWatch(
            code,
            subs.map((s) => s.track.id),
          );
        } catch (err) {
          this.opts.log?.warn({ code, err }, 'startPlayback failed — manual playback fallback');
        }
      } else {
        this.opts.log?.info({ code }, 'no active Spotify device — manual playback mode');
      }
    }

    this.playbackModes.set(code, mode);
    this.broadcast(code);
  }

  private async hasLiveSession(): Promise<boolean> {
    if (this.probe === undefined) return false;
    try {
      return (await this.probe.getAccessToken()) !== null;
    } catch {
      return false;
    }
  }

  /** Fire-and-forget cache refresh so snapshots reflect OAuth without async seams. */
  private lastLivenessCheck = 0;
  private livenessCache = false;
  private async refreshSessionLiveness(_code: string): Promise<void> {
    if (this.probe === undefined) return;
    const now = Date.now();
    if (now - this.lastLivenessCheck < 30_000) return;
    this.lastLivenessCheck = now;
    this.livenessCache = await this.hasLiveSession();
  }

  private startQueueWatch(code: string, trackIds: string[]): void {
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
    const poller = this.stateProbe;
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

  // ── Placeholder judge handoff (real judge lands Phase 4) ────────────────────

  private armJudgeTimer(code: string, deadline: number): void {
    this.timers.arm(`judge:${code}`, deadline, () => void this.storePlaceholderJudgement(code));
  }

  /**
   * The AI_JUDGING 20 s timeout delegates here (controller callback, TDD §8):
   * log, then immediately dispatch JUDGEMENT_STORED with placeholder results so
   * RESULTS/LEADERBOARD are reachable end-to-end before the judge exists.
   */
  private async storePlaceholderJudgement(code: string): Promise<void> {
    const fsm = this.fsms.get(code);
    if (fsm === undefined || fsm.state !== 'AI_JUDGING') return;
    this.opts.log?.info({ code, placeholder: true }, 'placeholder judge: storing judgement');
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
