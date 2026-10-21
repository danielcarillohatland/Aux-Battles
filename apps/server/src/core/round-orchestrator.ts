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
 *  - Catalog playback resolves every submitted id against an approved provider.
 *    The host browser plays each card and explicitly advances.
 *  - Batched judge (Phase 4, TDD §8): entering AI_JUDGING arms the phase
 *    deadline as a failsafe and calls judgeTrack over the LLMProvider seam
 *    (retries + deterministic hash fallback live inside the judge). The stored
 *    verdict dispatches JUDGEMENT_STORED and rides a `judgement` WS frame.
 */
import { randomInt, randomUUID } from 'node:crypto';
import type { FsmState, PlaybackMode, Snapshot } from '@aux/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { RoomManager } from './room-manager.js';
import { RoomFsm } from '../fsm/engine.js';
import type { FsmChange } from '../fsm/types.js';
import type { WsHub, WsViewer } from '../ws/types.js';
import type { ApprovedMusicCatalog } from '../providers/music-provider.js';
import type { StoredSubmission } from './submissions.js';
import { pointsForRank, ResultsStore, type ResultsPayload } from './results.js';
import type { JudgeEntry, JudgedEntry } from '../judge/judge-service.js';
import { LlmProviderError, type LLMProvider } from '../judge/llm-provider.js';
import { judgeTrack } from '../judge/service.js';
import { JUDGE_PROMPT_VERSION } from '../judge/prompt.js';
import { resolveRoundPrompt } from './scenarios.js';

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

/** Placeholder a viewer sees for a player they reported and chose to hide. */
export const HIDDEN_PLAYER = 'Hidden player';

export interface RoundOrchestratorOptions {
  roomManager: RoomManager;
  /** Viewer-local moderation: true when `viewerId` hid `targetId` in this room. */
  isHidden?: (code: string, viewerId: string, targetId: string) => boolean;
  /** Attached right after initWsHub at the composition root (or in tests). */
  wsHub?: WsHub | undefined;
  log?: FastifyBaseLogger | undefined;
  /** Read view of core/submissions.ts; counts degrade to 0/false when absent. */
  submissions?: SubmissionStoreView | undefined;
  /**
   * Phase-4 judgement persistence (TDD §6): durable per-round judgement rows +
   * rank-points leaderboard math. When attached, every stored judgement rides
   * the orchestrator checkpoint fragment (`judgements`) so results and the
   * rank-points standings survive restarts.
   */
  results?: ResultsStore | undefined;
  /**
   * LLM seam (D-012) handed to judgeTrack (TDD §8). Absent/null → the
   * deterministic hash fallback judges every round; an outage or timeout
   * degrades to the same path — a party never stalls on the vendor.
   */
  llm?: LLMProvider | undefined;
  /** AUX BATTLES excerpt length; production default is 30 seconds. */
  excerptDurationMs?: number | undefined;
  /** False selects crowd practice without attempting a paid model or reporting an outage. */
  canUseAi?: (code: string, roundIdx: number) => boolean;
  onRoundFailure?: (code: string, reason: string) => void | Promise<void>;
  crowdVoteDurationMs?: number;
}

type JudgingStatus = 'idle' | 'listening' | 'analyzing' | 'revealed' | 'voting';
type ExcerptStatus = 'ready' | 'starting' | 'playing' | 'complete' | 'failed';

interface CrowdBallot {
  id: string;
  options: Array<{ id: string; index: number }>;
  eligiblePlayerIds: string[];
  votes: Record<string, string>;
  closesAt: number;
  closed: boolean;
}

interface JudgeRoundState {
  roundIdx: number;
  mode: 'ai' | 'crowd';
  complete: boolean;
  failureNotified: boolean;
  promptVersion: string;
  model?: string;
  ballot?: CrowdBallot;
  /** Why this round fell back to crowd voting; absent for chosen crowd play. */
  crowdReason?: string;
}

/** Player-facing category for a crowd fallback reason. */
export function judgeNoticeFor(reason: string | undefined): 'off_duty' | 'unavailable' | null {
  if (!reason) return null;
  return reason === 'budget_exhausted' ? 'off_duty' : 'unavailable';
}

export const CROWD_TIE_POLICY =
  'Most votes wins. Ties share the same place and points. A round with no votes awards no points.';

export interface OrchestratorPayload {
  version: 1;
  category?: string;
  scenario?: string;
  scenarioVibe?: string;
  recentScenarioIds?: string[];
  queue?: StoredSubmission[];
  playbackIndex?: number;
  playbackMode?: PlaybackMode;
  playbackDevice?: { id: string; name: string };
  playbackError?: string;
  playbackStatus?: ExcerptStatus;
  excerptStartMs?: number;
  excerptDurationMs?: number;
  excerptStartedAt?: number;
  results?: JudgedEntry[];
  judgingIndex?: number;
  judgingStatus?: JudgingStatus;
  judgingResults?: Array<{ index: number; entry: JudgedEntry }>;
  judgeRound?: JudgeRoundState;
  revealIndex?: number;
  leaderboard?: Array<{
    playerId: string;
    nickname: string;
    totalScore: number;
    wins: number;
  }>;
  /**
   * Phase-4 addition (OPTIONAL — checkpoint shape stays backward compatible):
   * raw §6 judgement rows from core/results.ts, so a restart can recompute the
   * rank-points leaderboard from source records, not just the cached board.
   */
  judgements?: ResultsPayload;
}

export const DEFAULT_EXCERPT_DURATION_MS = 30_000;
/** Upper bound for one verdict on the Judge screen (retries included). */
export const JUDGE_HARD_LIMIT_MS = 30_000;

export function roundIdOf(code: string, roundIdx: number): string {
  return `${code}:${roundIdx}`;
}

/** Pick an equal-length representative window with a clean ending guard. */
export function chooseExcerptWindow(
  durationMs: number | undefined,
  requestedMs = DEFAULT_EXCERPT_DURATION_MS,
): { excerptStartMs: number; excerptDurationMs: number } {
  const safeDuration = Math.max(1, Math.floor(durationMs ?? 180_000));
  const excerptDurationMs = Math.min(Math.max(1, Math.floor(requestedMs)), safeDuration);
  if (safeDuration <= excerptDurationMs + 5_000) {
    return { excerptStartMs: 0, excerptDurationMs };
  }
  const endGuardedStart = Math.max(0, safeDuration - excerptDurationMs - 5_000);
  const representativeMiddle = Math.floor(safeDuration * 0.38);
  return {
    excerptStartMs: Math.min(representativeMiddle, endGuardedStart),
    excerptDurationMs,
  };
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

export class RoundOrchestrator {
  onChanged: ((code: string) => void) | null = null;
  private hub: WsHub | undefined;
  private catalogPlayback: ApprovedMusicCatalog | undefined;

  /** code → live FSM (registered by game-runtimes at creation/rehydration). */
  private readonly fsms = new Map<string, RoomFsm>();
  /** Cached D-E mode per room; sync-readable by the snapshot builder. */
  private readonly playbackModes = new Map<string, PlaybackMode>();
  private readonly categories = new Map<string, string>();
  private readonly scenarios = new Map<string, string>();
  private readonly scenarioVibes = new Map<string, string>();
  private readonly recentScenarioIds = new Map<string, string[]>();
  private readonly queues = new Map<string, StoredSubmission[]>();
  private readonly playbackIndexes = new Map<string, number>();
  private readonly playbackDevices = new Map<string, { id: string; name: string }>();
  private readonly playbackErrors = new Map<string, string>();
  private readonly playbackStatuses = new Map<string, ExcerptStatus>();
  private readonly excerptStarts = new Map<string, number>();
  private readonly excerptDurations = new Map<string, number>();
  private readonly excerptStartedAts = new Map<string, number>();
  private readonly advancingPlayback = new Set<string>();
  private readonly advancingJudgement = new Set<string>();
  private readonly results = new Map<string, JudgedEntry[]>();
  private readonly revealIndexes = new Map<string, number>();
  private readonly judgeRounds = new Map<string, JudgeRoundState>();
  private readonly roundControllers = new Map<string, AbortController>();
  private readonly voteTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly judgingIndexes = new Map<string, number>();
  private readonly judgingStatuses = new Map<string, JudgingStatus>();
  private readonly judgingResults = new Map<string, Map<number, JudgedEntry>>();
  private readonly leaderboard = new Map<
    string,
    Map<string, { playerId: string; nickname: string; totalScore: number; wins: number }>
  >();

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

  /** Browser playback backed only by project-owned or validated licensed media. */
  setCatalogPlayback(catalog: ApprovedMusicCatalog): void {
    this.catalogPlayback = catalog;
  }

  /** Attach/replace the submission read view (wired late at the composition root). */
  setSubmissions(store: SubmissionStoreView | undefined): void {
    this.opts.submissions = store;
  }

  /** Attach/replace the Phase-4 judgement store (wired late at the composition root). */
  setResults(store: ResultsStore | undefined): void {
    this.opts.results = store;
  }

  private manualPlaybackHint: string | undefined;

  /** Operator-facing explanation shown on the host when a round falls back to manual playback. */
  setManualPlaybackHint(hint: string | undefined): void {
    this.manualPlaybackHint = hint;
  }

  /** Attach/replace the LLM provider behind judgeTrack (config-swappable, D-012). */
  setLlm(llm: LLMProvider | undefined): void {
    this.opts.llm = llm;
  }

  serialize(code: string): OrchestratorPayload {
    const payload: OrchestratorPayload = { version: 1 };
    const category = this.categories.get(code);
    const queue = this.queues.get(code);
    const scenario = this.scenarios.get(code);
    const recentScenarioIds = this.recentScenarioIds.get(code);
    const playbackIndex = this.playbackIndexes.get(code);
    const playbackMode = this.playbackModes.get(code);
    const playbackDevice = this.playbackDevices.get(code);
    const playbackError = this.playbackErrors.get(code);
    const playbackStatus = this.playbackStatuses.get(code);
    const excerptStartMs = this.excerptStarts.get(code);
    const excerptDurationMs = this.excerptDurations.get(code);
    const excerptStartedAt = this.excerptStartedAts.get(code);
    const results = this.results.get(code);
    const judgingIndex = this.judgingIndexes.get(code);
    const judgingStatus = this.judgingStatuses.get(code);
    const judgingResults = this.judgingResults.get(code);
    const judgeRound = this.judgeRounds.get(code);
    const revealIndex = this.revealIndexes.get(code);
    const leaderboard = this.leaderboard.get(code);
    if (category !== undefined) payload.category = category;
    if (scenario !== undefined) payload.scenario = scenario;
    const scenarioVibe = this.scenarioVibes.get(code);
    if (scenarioVibe !== undefined) payload.scenarioVibe = scenarioVibe;
    if (recentScenarioIds !== undefined) payload.recentScenarioIds = recentScenarioIds;
    if (queue !== undefined) payload.queue = queue;
    if (playbackIndex !== undefined) payload.playbackIndex = playbackIndex;
    if (playbackMode !== undefined) payload.playbackMode = playbackMode;
    if (playbackDevice !== undefined) payload.playbackDevice = playbackDevice;
    if (playbackError !== undefined) payload.playbackError = playbackError;
    if (playbackStatus !== undefined) payload.playbackStatus = playbackStatus;
    if (excerptStartMs !== undefined) payload.excerptStartMs = excerptStartMs;
    if (excerptDurationMs !== undefined) payload.excerptDurationMs = excerptDurationMs;
    if (excerptStartedAt !== undefined) payload.excerptStartedAt = excerptStartedAt;
    if (results !== undefined) payload.results = results;
    if (judgingIndex !== undefined) payload.judgingIndex = judgingIndex;
    if (judgingStatus !== undefined) payload.judgingStatus = judgingStatus;
    if (judgeRound !== undefined) payload.judgeRound = structuredClone(judgeRound);
    if (judgingResults !== undefined) {
      payload.judgingResults = [...judgingResults].map(([index, entry]) => ({ index, entry }));
    }
    if (revealIndex !== undefined) payload.revealIndex = revealIndex;
    if (leaderboard !== undefined) payload.leaderboard = [...leaderboard.values()];
    const judgements = this.opts.results?.serialize(code);
    if (judgements !== undefined) payload.judgements = judgements;
    return payload;
  }

  hydrate(code: string, payload: OrchestratorPayload | null | undefined): void {
    if (payload?.version !== 1) return;
    if (payload.category !== undefined) this.categories.set(code, payload.category);
    if (payload.scenario !== undefined) this.scenarios.set(code, payload.scenario);
    if (payload.scenarioVibe !== undefined) this.scenarioVibes.set(code, payload.scenarioVibe);
    if (payload.recentScenarioIds !== undefined)
      this.recentScenarioIds.set(code, payload.recentScenarioIds);
    if (payload.queue !== undefined) this.queues.set(code, payload.queue);
    if (payload.playbackIndex !== undefined) this.playbackIndexes.set(code, payload.playbackIndex);
    if (payload.playbackMode !== undefined) this.playbackModes.set(code, payload.playbackMode);
    if (payload.playbackDevice !== undefined)
      this.playbackDevices.set(code, payload.playbackDevice);
    if (payload.playbackError !== undefined) this.playbackErrors.set(code, payload.playbackError);
    if (payload.playbackStatus !== undefined)
      this.playbackStatuses.set(code, payload.playbackStatus);
    if (payload.excerptStartMs !== undefined) this.excerptStarts.set(code, payload.excerptStartMs);
    if (payload.excerptDurationMs !== undefined)
      this.excerptDurations.set(code, payload.excerptDurationMs);
    if (payload.excerptStartedAt !== undefined)
      this.excerptStartedAts.set(code, payload.excerptStartedAt);
    if (payload.results !== undefined) this.results.set(code, payload.results);
    if (payload.judgingIndex !== undefined) this.judgingIndexes.set(code, payload.judgingIndex);
    if (payload.judgingStatus !== undefined) this.judgingStatuses.set(code, payload.judgingStatus);
    if (payload.judgeRound !== undefined)
      this.judgeRounds.set(code, structuredClone(payload.judgeRound));
    if (payload.judgingResults !== undefined) {
      this.judgingResults.set(
        code,
        new Map(payload.judgingResults.map(({ index, entry }) => [index, entry])),
      );
    }
    if (payload.revealIndex !== undefined) this.revealIndexes.set(code, payload.revealIndex);
    if (payload.leaderboard !== undefined) {
      this.leaderboard.set(
        code,
        new Map(payload.leaderboard.map((entry) => [entry.playerId, entry])),
      );
    }
    // §6 judgement rows restore AFTER the cached board: the board is render
    // state, the rows are source-of-truth and recompute-ready.
    this.opts.results?.hydrate(payload.judgements);
  }

  // ── Runtime registry (fed by game-runtimes.ts) ──────────────────────────────

  /** Register a room's FSM and resume any interrupted judgement transition. */
  register(code: string, fsm: RoomFsm): void {
    if (this.fsms.get(code) === fsm) return;
    this.fsms.set(code, fsm);
    let restored = this.judgeRounds.get(code);
    const legacyResults = this.judgingResults.get(code);
    if (!restored && legacyResults && ['PLAYBACK', 'AI_JUDGING'].includes(fsm.state)) {
      const models = new Set([...legacyResults.values()].map((entry) => entry.judgeModel));
      const model = models.values().next().value;
      restored = {
        roundIdx: fsm.roundIdx,
        mode: 'ai',
        failureNotified: false,
        promptVersion: 'legacy',
        complete:
          legacyResults.size === this.entriesFor(code, roundIdOf(code, fsm.roundIdx)).length &&
          models.size === 1 &&
          model !== 'fallback-hash',
        ...(model ? { model } : {}),
      };
      this.judgeRounds.set(code, restored);
    }
    if (restored?.mode === 'ai' && !restored.complete) {
      // An interrupted request may already have been billed. Never reroll it after restart.
      this.switchToCrowd(code, fsm, restored, 'interrupted');
    }
    if (fsm.state === 'AI_JUDGING' && this.results.has(code)) {
      // A checkpoint can land after scores were awarded but before the FSM
      // advanced. Complete that transition without judging or awarding again.
      void this.dispatchQuietly(fsm, 'JUDGEMENT_STORED');
      return;
    }
    if (fsm.state === 'PLAYBACK') {
      if (restored === undefined) this.prejudgeAll(code);
      this.playbackStatuses.set(code, 'ready');
      void this.startCurrentExcerpt(code);
    }
    if (fsm.state === 'AI_JUDGING' && this.judgingStatuses.get(code) !== 'revealed') {
      void this.startCurrentJudgement(code);
    }
  }

  forget(code: string): void {
    void this.stopExcerpt(code);
    this.fsms.delete(code);
    this.playbackModes.delete(code);
    this.categories.delete(code);
    this.scenarios.delete(code);
    this.scenarioVibes.delete(code);
    this.recentScenarioIds.delete(code);
    this.queues.delete(code);
    this.playbackIndexes.delete(code);
    this.playbackDevices.delete(code);
    this.playbackErrors.delete(code);
    this.playbackStatuses.delete(code);
    this.excerptStarts.delete(code);
    this.excerptDurations.delete(code);
    this.excerptStartedAts.delete(code);
    this.results.delete(code);
    this.revealIndexes.delete(code);
    this.clearRoundJobs(code);
    this.judgeRounds.delete(code);
    this.judgingIndexes.delete(code);
    this.judgingStatuses.delete(code);
    this.judgingResults.delete(code);
    this.leaderboard.delete(code);
    // Phase-4 symmetry with submissions.clearRoom: evicted rooms drop their
    // durable judgement rows too.
    this.opts.results?.clearRoom(code);
  }

  // ── FSM side effects ────────────────────────────────────────────────────────

  /**
   * Awaited inside the FSM's onChange hook (after persist/timer arming), so
   * broadcast ordering stays deterministic; async follow-ups are fire-and-
   * forget and never block the mutex.
   */
  onTransition(change: FsmChange): void {
    if (change.event === 'PICK_CATEGORY' && change.payload?.category !== undefined) {
      // The host's pick is a vibe (theme), a surprise, or a custom prompt (D-029).
      const draw = resolveRoundPrompt(
        change.payload.category,
        this.recentScenarioIds.get(change.code) ?? [],
      );
      this.categories.set(change.code, draw.theme);
      this.recentScenarioIds.set(change.code, draw.recentIds);
      this.scenarios.set(change.code, draw.scenario);
      if (draw.vibe !== null) this.scenarioVibes.set(change.code, draw.vibe);
      else this.scenarioVibes.delete(change.code);
    }
    if (change.event === 'NEXT_ROUND') {
      this.clearRoundJobs(change.code);
      this.judgeRounds.delete(change.code);
      this.queues.delete(change.code);
      this.playbackIndexes.delete(change.code);
      this.results.delete(change.code);
      this.revealIndexes.delete(change.code);
      this.judgingIndexes.delete(change.code);
      this.judgingStatuses.delete(change.code);
      this.judgingResults.delete(change.code);
      this.playbackErrors.delete(change.code);
      this.playbackStatuses.delete(change.code);
      this.excerptStarts.delete(change.code);
      this.excerptDurations.delete(change.code);
      this.excerptStartedAts.delete(change.code);
    }
    if (change.from === 'PLAYBACK' && change.to !== 'PLAYBACK') {
      void this.stopExcerpt(change.code);
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
        this.judgingIndexes.set(change.code, this.judgingIndexes.get(change.code) ?? 0);
        this.judgingStatuses.set(change.code, 'idle');
        void this.startCurrentJudgement(change.code);
        break;
      default:
        break;
    }
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
    const queue = this.queues.get(code) ?? [];
    const judgingIndex = this.judgingIndexes.get(code) ?? 0;
    const judgeRound = this.judgeRounds.get(code);
    const currentJudged =
      judgeRound?.mode === 'ai' && judgeRound.complete && state === 'AI_JUDGING'
        ? this.judgingResults.get(code)?.get(judgingIndex)
        : undefined;
    const ballot = state === 'AI_JUDGING' ? judgeRound?.ballot : undefined;
    const crowdEntries = this.entriesFor(code, roundId);
    const visibleResultCount =
      state === 'RESULTS' ? (this.revealIndexes.get(code) ?? 0) : allResults.length;
    const hidden = (targetId: string): boolean =>
      targetId !== viewer.playerId &&
      this.opts.isHidden?.(code, viewer.playerId, targetId) === true;
    const shownName = (targetId: string, nickname: string): string =>
      hidden(targetId) ? HIDDEN_PLAYER : nickname;

    return {
      roomCode: code,
      state,
      roundIdx,
      phaseEndsAt: fsm?.phaseEndsAt ?? null,
      playbackMode: this.playbackModes.get(code) ?? 'catalog',
      players: [...room.players.entries()]
        .filter(([id]) => id !== room.hostPlayerId)
        .map(([id, p]) => ({ nickname: shownName(id, p.nickname), connected: p.connected })),
      submissionsCount: subs?.count(roundId) ?? 0,
      category: this.categories.get(code) ?? null,
      scenario: this.scenarios.get(code) ?? null,
      scenarioVibe: this.scenarioVibes.get(code) ?? null,
      queue: queue.map((submission) => submission.track),
      playbackIndex: state === 'AI_JUDGING' ? judgingIndex : (this.playbackIndexes.get(code) ?? 0),
      playbackDevice: this.playbackDevices.get(code)?.name ?? null,
      playbackError: this.playbackErrors.get(code) ?? null,
      playbackStatus: this.playbackStatuses.get(code) ?? 'ready',
      excerptStartMs: this.excerptStarts.get(code) ?? 0,
      excerptDurationMs:
        this.excerptDurations.get(code) ??
        Math.min(
          this.opts.excerptDurationMs ?? DEFAULT_EXCERPT_DURATION_MS,
          queue[this.playbackIndexes.get(code) ?? 0]?.track.durationMs ??
            this.opts.excerptDurationMs ??
            DEFAULT_EXCERPT_DURATION_MS,
        ),
      excerptStartedAt: this.excerptStartedAts.get(code) ?? null,
      judgingIndex,
      judgingCount: queue.length,
      judgingStatus: this.judgingStatuses.get(code) ?? 'idle',
      judgingMode: judgeRound?.mode ?? 'ai',
      judgeNotice: room.aiOffDuty
        ? 'off_duty'
        : judgeRound?.mode === 'crowd'
          ? judgeNoticeFor(judgeRound.crowdReason)
          : null,
      judgingCompleted: judgeRound?.mode === 'ai' ? (this.judgingResults.get(code)?.size ?? 0) : 0,
      crowdVote:
        ballot && !ballot.closed
          ? {
              ballotId: ballot.id,
              options: ballot.options
                .filter((option) => crowdEntries[option.index]?.playerId !== viewer.playerId)
                .map((option) => ({ id: option.id, track: crowdEntries[option.index]!.track })),
              eligible: ballot.eligiblePlayerIds.includes(viewer.playerId),
              voted: ballot.votes[viewer.playerId] !== undefined,
              received: Object.keys(ballot.votes).length,
              eligibleCount: ballot.eligiblePlayerIds.length,
              closesAt: ballot.closesAt,
              canClose: this.canCloseBallot(code, ballot),
              tiePolicy: CROWD_TIE_POLICY,
            }
          : null,
      judgingTrack: queue[judgingIndex]?.track ?? null,
      judgingDefense:
        queue[judgingIndex] !== undefined && hidden(queue[judgingIndex]!.playerId)
          ? null
          : (queue[judgingIndex]?.defense ?? null),
      judgingResult:
        currentJudged?.categories !== undefined && currentJudged.totalScore !== undefined
          ? {
              categories: currentJudged.categories,
              totalScore: currentJudged.totalScore,
              ...(currentJudged.verdict !== undefined ? { verdict: currentJudged.verdict } : {}),
              ...(currentJudged.reasons !== undefined ? { reasons: currentJudged.reasons } : {}),
              ...(currentJudged.defenseNote !== undefined
                ? { defenseNote: currentJudged.defenseNote }
                : {}),
              explanation: currentJudged.explanation,
              judgeModel: currentJudged.judgeModel,
              ...(currentJudged.confidence !== undefined
                ? { confidence: currentJudged.confidence }
                : {}),
            }
          : null,
      results: allResults.slice(0, visibleResultCount).map((result) => ({
        rank: result.rank,
        score: result.score,
        explanation: result.explanation,
        judgeModel: result.judgeModel,
        ...(result.verdict !== undefined ? { verdict: result.verdict } : {}),
        ...(result.reasons !== undefined ? { reasons: result.reasons } : {}),
        ...(result.defenseNote !== undefined ? { defenseNote: result.defenseNote } : {}),
        ...(result.defense !== undefined && !hidden(result.playerId)
          ? { defense: result.defense }
          : {}),
        ...(result.categories !== undefined ? { categories: result.categories } : {}),
        ...(result.totalScore !== undefined ? { totalScore: result.totalScore } : {}),
        ...(result.confidence !== undefined ? { confidence: result.confidence } : {}),
        track: result.track,
        owner: shownName(
          result.playerId,
          room.players.get(result.playerId)?.nickname ?? 'Mystery DJ',
        ),
        chicken: result.chicken,
      })),
      resultCount: allResults.length,
      revealIndex: visibleResultCount,
      leaderboard: [...(this.leaderboard.get(code)?.values() ?? [])]
        .sort((a, b) => b.totalScore - a.totalScore || b.wins - a.wins)
        .map((entry) => ({ ...entry, nickname: shownName(entry.playerId, entry.nickname) })),
      you: {
        role: viewer.role,
        hasSubmitted: subs?.hasSubmitted(roundId, viewer.playerId) ?? false,
        nickname: viewer.nickname,
      },
    };
  }

  // ── Playback orchestration (LOCKED → PLAYBACK, TDD §7/D-E) ─────────────────

  /** Build a shuffled deck and re-resolve every id for safe browser playback. */
  private async enterPlayback(code: string): Promise<void> {
    const fsm = this.fsms.get(code);
    if (fsm === undefined || fsm.state !== 'PLAYBACK') return;

    const subs = shuffled(this.opts.submissions?.list(roundIdOf(code, fsm.roundIdx)) ?? []);
    this.queues.set(code, subs);
    this.playbackIndexes.set(code, 0);
    this.playbackStatuses.set(code, 'ready');
    let mode: PlaybackMode = 'manual';
    this.playbackErrors.delete(code);
    this.playbackDevices.delete(code);
    if (this.catalogPlayback !== undefined && subs.length > 0) {
      const approvedQueue: StoredSubmission[] = [];
      let unresolved: StoredSubmission | undefined;
      for (const submission of subs) {
        // The stored track was canonicalized by the catalog at submission time,
        // so each provider only has to recognise its own ids and attach
        // room-bound playback data — this also survives a process restart.
        const track = this.catalogPlayback.playableTrack(submission.track, code);
        if (track === null) {
          unresolved = submission;
          break;
        }
        approvedQueue.push({ ...submission, track });
      }
      if (approvedQueue.length === subs.length) {
        this.queues.set(code, approvedQueue);
        this.playbackErrors.delete(code);
        this.playbackDevices.set(code, { id: 'catalog-browser', name: 'Host browser' });
        mode = 'catalog';
        this.opts.log?.info({ code }, 'approved in-app catalog playback ready');
      } else if (unresolved?.track.source === 'manual') {
        // Player-entered or gallery picks without an in-game player: say why.
        this.playbackErrors.set(
          code,
          this.manualPlaybackHint ?? 'Open each song in your music app, then press Next song.',
        );
      } else {
        this.playbackErrors.set(code, 'A submitted song is no longer in the approved catalog.');
      }
    }

    this.playbackModes.set(code, mode);
    this.checkpoint(code);
    this.broadcast(code);
    void this.startCurrentExcerpt(code);
    // Everything the judge needs (scenario, songs, defenses) is final now, so
    // judge in the background during Listening; verdicts are ready on arrival.
    this.prejudgeAll(code);
  }

  /** Stop the old excerpt before advancing the card; final card begins judging. */
  async manualNext(code: string): Promise<'advanced' | 'done' | 'invalid'> {
    const fsm = this.fsms.get(code);
    if (fsm === undefined || fsm.state !== 'PLAYBACK' || this.advancingPlayback.has(code)) {
      return 'invalid';
    }
    this.advancingPlayback.add(code);
    try {
      // Keep the guard active through one microtask so two same-tick taps
      // cannot skip two cards now that browser playback has no remote pause.
      await Promise.resolve();
      this.stopExcerpt(code);
      const queue = this.queues.get(code) ?? [];
      const current = this.playbackIndexes.get(code) ?? 0;
      if (current >= queue.length - 1) {
        await this.dispatchQuietly(fsm, 'QUEUE_DONE');
        return 'done';
      }
      this.playbackIndexes.set(code, current + 1);
      this.playbackStatuses.set(code, 'ready');
      this.playbackErrors.delete(code);
      this.checkpoint(code);
      this.broadcast(code);
      void this.startCurrentExcerpt(code);
      return 'advanced';
    } finally {
      this.advancingPlayback.delete(code);
    }
  }

  private startCurrentExcerpt(code: string): void {
    const fsm = this.fsms.get(code);
    if (fsm === undefined || fsm.state !== 'PLAYBACK') return;
    const index = this.playbackIndexes.get(code) ?? 0;
    const submission = this.queues.get(code)?.[index];
    if (submission === undefined) return;
    // Preview-clip catalogs play less audio than the full recording lasts.
    const window = chooseExcerptWindow(
      submission.track.playableMs ?? submission.track.durationMs,
      this.opts.excerptDurationMs ?? DEFAULT_EXCERPT_DURATION_MS,
    );
    this.excerptStarts.set(code, window.excerptStartMs);
    this.excerptDurations.set(code, window.excerptDurationMs);
    this.excerptStartedAts.delete(code);

    if (this.playbackModes.get(code) === 'catalog') {
      this.playbackStatuses.set(code, 'ready');
      this.playbackErrors.delete(code);
      this.checkpoint(code);
      this.broadcast(code);
      return;
    }
    this.playbackStatuses.set(code, 'failed');
    if (!this.playbackErrors.has(code)) {
      this.playbackErrors.set(
        code,
        this.manualPlaybackHint ?? 'In-app playback is unavailable. Continue to judge the cards.',
      );
    }
    this.checkpoint(code);
    this.broadcast(code);
  }

  private stopExcerpt(code: string): void {
    this.excerptStartedAts.delete(code);
  }

  // ── Whole-round judging: one scoring mode, one model, no partial reveals ──

  private clearRoundJobs(code: string): void {
    this.roundControllers.get(code)?.abort();
    this.roundControllers.delete(code);
    this.advancingJudgement.delete(code);
    clearTimeout(this.voteTimers.get(code));
    this.voteTimers.delete(code);
  }

  private currentRound(code: string, fsm: RoomFsm, round: JudgeRoundState): boolean {
    return (
      this.fsms.get(code) === fsm &&
      fsm.roundIdx === round.roundIdx &&
      this.judgeRounds.get(code) === round &&
      (fsm.state === 'PLAYBACK' || fsm.state === 'AI_JUDGING')
    );
  }

  /** Idempotent per room/round; cached work is never reissued by client refreshes. */
  private prejudgeAll(code: string): void {
    const fsm = this.fsms.get(code);
    if (!fsm || !['PLAYBACK', 'AI_JUDGING'].includes(fsm.state) || this.judgeRounds.has(code))
      return;
    const round: JudgeRoundState = {
      roundIdx: fsm.roundIdx,
      mode: 'ai',
      complete: false,
      failureNotified: false,
      promptVersion: JUDGE_PROMPT_VERSION,
    };
    this.judgeRounds.set(code, round);
    const entries = this.entriesFor(code, roundIdOf(code, fsm.roundIdx));
    if (this.opts.canUseAi?.(code, fsm.roundIdx) === false) {
      this.switchToCrowd(code, fsm, round);
      return;
    }
    if (!this.opts.llm) {
      this.switchToCrowd(code, fsm, round, 'unconfigured');
      return;
    }
    if (entries.length === 0) {
      round.complete = true;
      this.checkpoint(code);
      return;
    }
    const provider = this.opts.llm;
    const controller = new AbortController();
    this.roundControllers.set(code, controller);
    this.judgingResults.set(code, new Map());
    const timer = setTimeout(() => {
      if (this.currentRound(code, fsm, round) && !round.complete)
        this.switchToCrowd(code, fsm, round, 'round_deadline');
    }, JUDGE_HARD_LIMIT_MS);
    timer.unref?.();
    this.checkpoint(code);
    const roundSongs = entries.map(({ track }) => ({ title: track.title, artist: track.artist }));
    void Promise.all(
      entries.map(async (entry, index) => {
        const judged = await judgeTrack(
          this.scenarios.get(code) ?? 'the perfect song for this moment',
          {
            index,
            id: entry.track.id,
            title: entry.track.title,
            artist: entry.track.artist,
            roundSongs,
            ...(entry.track.description ? { description: entry.track.description } : {}),
            ...(entry.defense ? { defense: entry.defense } : {}),
          },
          provider,
          {
            attempts: 2,
            timeoutMs: 12_000,
            ...(this.scenarioVibes.has(code) ? { vibe: this.scenarioVibes.get(code)! } : {}),
            signal: controller.signal,
            context: {
              roomCode: code,
              roundIdx: round.roundIdx,
              promptVersion: round.promptVersion,
            },
            onFailure: ({ attempt, error, model }) =>
              this.opts.log?.warn(
                {
                  code,
                  roundIdx: round.roundIdx,
                  model,
                  promptVersion: round.promptVersion,
                  attempt,
                  reason: error instanceof LlmProviderError ? error.code : 'invalid_response',
                },
                'AI judge attempt failed',
              ),
          },
        );
        if (!this.currentRound(code, fsm, round) || round.mode !== 'ai') return;
        if (round.model !== undefined && round.model !== judged.judgeModel)
          throw new LlmProviderError(
            'model_changed',
            'The provider changed models within the round',
            false,
          );
        round.model = judged.judgeModel;
        const result: JudgedEntry = {
          ...entry,
          rank: 0,
          score: Math.round(judged.totalScore * 10),
          totalScore: judged.totalScore,
          categories: judged.categories,
          explanation: judged.explanation,
          judgeModel: judged.judgeModel,
          ...(judged.verdict ? { verdict: judged.verdict } : {}),
          ...(judged.reasons ? { reasons: judged.reasons } : {}),
          ...(judged.defenseNote ? { defenseNote: judged.defenseNote } : {}),
          confidence: judged.confidence,
        };
        this.judgingResults.get(code)?.set(index, result);
        this.checkpoint(code);
        this.broadcast(code);
      }),
    )
      .then(() => {
        if (!this.currentRound(code, fsm, round) || round.mode !== 'ai') return;
        round.complete = true;
        this.opts.log?.info(
          {
            code,
            roundIdx: round.roundIdx,
            model: round.model,
            promptVersion: round.promptVersion,
            tracks: entries.length,
          },
          'AI round complete',
        );
        this.checkpoint(code);
        if (fsm.state === 'AI_JUDGING') void this.startCurrentJudgement(code);
      })
      .catch((error: unknown) => {
        if (this.currentRound(code, fsm, round) && round.mode === 'ai')
          this.switchToCrowd(
            code,
            fsm,
            round,
            error instanceof LlmProviderError ? error.code : 'invalid_response',
          );
      })
      .finally(() => clearTimeout(timer));
  }

  private switchToCrowd(code: string, fsm: RoomFsm, round: JudgeRoundState, reason?: string): void {
    if (!this.currentRound(code, fsm, round)) return;
    round.mode = 'crowd';
    round.complete = false;
    if (reason) round.crowdReason = reason;
    this.roundControllers.get(code)?.abort();
    this.judgingResults.delete(code);
    if (reason && !round.failureNotified) {
      round.failureNotified = true;
      this.checkpoint(code);
      try {
        void Promise.resolve(this.opts.onRoundFailure?.(code, reason)).catch(() =>
          this.opts.log?.error({ code, reason }, 'Round failure callback failed'),
        );
      } catch {
        this.opts.log?.error({ code, reason }, 'Round failure callback failed');
      }
    }
    this.checkpoint(code);
    if (fsm.state === 'AI_JUDGING') this.openCrowdVote(code, fsm, round);
    this.broadcast(code);
  }

  private openCrowdVote(code: string, fsm: RoomFsm, round: JudgeRoundState): void {
    if (!this.currentRound(code, fsm, round) || fsm.state !== 'AI_JUDGING') return;
    if (!round.ballot) {
      const entries = this.entriesFor(code, roundIdOf(code, round.roundIdx));
      const room = this.opts.roomManager.get(code);
      round.ballot = {
        id: randomUUID(),
        options: entries.map((_, index) => ({ id: randomUUID(), index })),
        eligiblePlayerIds: [...(room?.players.keys() ?? [])].filter(
          (id) =>
            id !== room?.hostPlayerId &&
            entries.some((entry) => entry.playerId === id) &&
            entries.some((entry) => entry.playerId !== id),
        ),
        votes: {},
        closesAt: Date.now() + (this.opts.crowdVoteDurationMs ?? 45_000),
        closed: false,
      };
    }
    this.judgingStatuses.set(code, 'voting');
    this.checkpoint(code);
    this.broadcast(code);
    const ballot = round.ballot;
    if (ballot.closed) return;
    clearTimeout(this.voteTimers.get(code));
    const timer = setTimeout(
      () => void this.closeCrowdVote(code),
      Math.max(0, ballot.closesAt - Date.now()),
    );
    timer.unref?.();
    this.voteTimers.set(code, timer);
    if (ballot.eligiblePlayerIds.length === 0) void this.closeCrowdVote(code);
  }

  private canCloseBallot(code: string, ballot: CrowdBallot): boolean {
    const room = this.opts.roomManager.get(code);
    return (
      Date.now() >= ballot.closesAt ||
      ballot.eligiblePlayerIds.every(
        (id) => ballot.votes[id] !== undefined || room?.players.get(id)?.connected !== true,
      )
    );
  }

  castCrowdVote(
    code: string,
    playerId: string,
    ballotId: string,
    optionId: string,
  ): 'accepted' | 'duplicate' | 'invalid' | 'ineligible' | 'closed' {
    const fsm = this.fsms.get(code);
    const round = this.judgeRounds.get(code);
    const ballot = round?.ballot;
    if (
      ballot?.id === ballotId &&
      ballot.votes[playerId] === optionId &&
      this.opts.roomManager.get(code)?.players.has(playerId)
    )
      return 'duplicate';
    if (
      !fsm ||
      fsm.state !== 'AI_JUDGING' ||
      round?.mode !== 'crowd' ||
      !ballot ||
      ballot.closed ||
      Date.now() >= ballot.closesAt
    )
      return 'closed';
    if (ballot.id !== ballotId) return 'invalid';
    if (
      !ballot.eligiblePlayerIds.includes(playerId) ||
      !this.opts.roomManager.get(code)?.players.has(playerId)
    )
      return 'ineligible';
    if (ballot.votes[playerId] !== undefined)
      return ballot.votes[playerId] === optionId ? 'duplicate' : 'invalid';
    const option = ballot.options.find((entry) => entry.id === optionId);
    const selected = option && this.entriesFor(code, roundIdOf(code, round.roundIdx))[option.index];
    if (!selected || selected.playerId === playerId) return 'invalid';
    ballot.votes[playerId] = optionId;
    this.checkpoint(code);
    this.broadcast(code);
    if (ballot.eligiblePlayerIds.every((id) => ballot.votes[id] !== undefined))
      void this.closeCrowdVote(code);
    return 'accepted';
  }

  async closeCrowdVote(code: string): Promise<'done' | 'waiting' | 'invalid'> {
    const fsm = this.fsms.get(code);
    const round = this.judgeRounds.get(code);
    const ballot = round?.ballot;
    if (!fsm || fsm.state !== 'AI_JUDGING' || round?.mode !== 'crowd' || !ballot || ballot.closed)
      return 'invalid';
    if (!this.canCloseBallot(code, ballot)) return 'waiting';
    ballot.closed = true;
    clearTimeout(this.voteTimers.get(code));
    this.voteTimers.delete(code);
    const entries = this.entriesFor(code, roundIdOf(code, round.roundIdx));
    const voteValues = Object.values(ballot.votes);
    const scored = ballot.options
      .map((option) => ({ option, votes: voteValues.filter((id) => id === option.id).length }))
      .sort((a, b) => b.votes - a.votes || a.option.index - b.option.index);
    const ranked: JudgedEntry[] = scored.map(({ option, votes }) => {
      const rank = scored.findIndex((entry) => entry.votes === votes) + 1;
      const verdict = voteValues.length
        ? `${votes} ${votes === 1 ? 'vote' : 'votes'} from the room.`
        : 'No votes were cast. No points awarded.';
      return {
        ...entries[option.index]!,
        rank,
        score: voteValues.length ? Math.round((votes / voteValues.length) * 100) : 0,
        judgeModel: voteValues.length ? 'crowd-vote-v1' : 'crowd-no-votes',
        verdict,
        explanation: `${verdict} ${CROWD_TIE_POLICY}`,
      };
    });
    round.complete = true;
    // The first closed-ballot checkpoint must include stored results and points.
    // A crash before storeJudgement can safely replay the still-open persisted ballot.
    await this.storeJudgement(code, roundIdOf(code, round.roundIdx), ranked);
    return 'done';
  }

  private async startCurrentJudgement(code: string): Promise<void> {
    const fsm = this.fsms.get(code);
    if (!fsm || fsm.state !== 'AI_JUDGING') return;
    this.prejudgeAll(code);
    const round = this.judgeRounds.get(code);
    if (!round) return;
    if (round.mode === 'crowd') {
      this.openCrowdVote(code, fsm, round);
      return;
    }
    if (this.entriesFor(code, roundIdOf(code, fsm.roundIdx)).length === 0) {
      await this.storeJudgement(code, roundIdOf(code, fsm.roundIdx), []);
      return;
    }
    this.judgingStatuses.set(code, round.complete ? 'revealed' : 'analyzing');
    this.checkpoint(code);
    this.broadcast(code);
  }

  /** Only cached results from a fully successful round may be advanced. */
  async nextJudgement(code: string): Promise<'advanced' | 'done' | 'invalid'> {
    if (this.advancingJudgement.has(code)) return 'invalid';
    this.advancingJudgement.add(code);
    try {
      await Promise.resolve();
      const fsm = this.fsms.get(code);
      const round = this.judgeRounds.get(code);
      if (
        !fsm ||
        fsm.state !== 'AI_JUDGING' ||
        round?.mode !== 'ai' ||
        !round.complete ||
        this.judgingStatuses.get(code) !== 'revealed'
      )
        return 'invalid';
      const entries = this.entriesFor(code, roundIdOf(code, fsm.roundIdx));
      const current = this.judgingIndexes.get(code) ?? 0;
      if (current >= entries.length - 1) {
        const partial = this.judgingResults.get(code) ?? new Map<number, JudgedEntry>();
        // Documented tiebreak: total, then scenario fit (the heaviest rubric line).
        // Entries equal on both share a place, like crowd voting; no hidden coin flip.
        const fit = (entry: JudgedEntry) => entry.categories?.scenarioFit ?? 0;
        const sorted = [...partial.entries()]
          .sort(
            ([aIndex, a], [bIndex, b]) => b.score - a.score || fit(b) - fit(a) || aIndex - bIndex,
          )
          .map(([, entry]) => entry);
        const ranked = sorted.map((entry) => ({
          ...entry,
          rank:
            sorted.findIndex((other) => other.score === entry.score && fit(other) === fit(entry)) +
            1,
        }));
        await this.storeJudgement(code, roundIdOf(code, fsm.roundIdx), ranked);
        return 'done';
      }
      this.judgingIndexes.set(code, current + 1);
      this.checkpoint(code);
      this.broadcast(code);
      return 'advanced';
    } finally {
      this.advancingJudgement.delete(code);
    }
  }

  /** Submission snapshot for one round, in the shape the judging layer consumes. */
  private entriesFor(code: string, roundId: string): JudgeEntry[] {
    return (this.queues.get(code) ?? this.opts.submissions?.list(roundId) ?? []).map(
      (submission) => ({
        playerId: submission.playerId,
        track: submission.track,
        chicken: submission.chicken,
        ...(submission.defense !== undefined ? { defense: submission.defense } : {}),
      }),
    );
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
    // §6 durability: raw judgement rows ride the checkpoint (idempotent — a
    // retry after a crash between here and JUDGEMENT_STORED replaces the rows).
    const roundIdx = Number(roundId.slice(code.length + 1));
    this.opts.results?.record(code, roundIdx, judged);
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
      // Scoring currency is RANK POINTS (§6 leaderboard_entries): 1st=5,
      // 2nd=3, 3rd=2, else 1. Judge scores are display-only.
      if (result.judgeModel !== 'crowd-no-votes') {
        current.totalScore += pointsForRank(result.rank);
        if (result.rank === 1) current.wins += 1;
      }
      board.set(result.playerId, current);
    }
    this.clearRoundJobs(code);
    this.publishJudgement(code, judged);
    this.checkpoint(code);
    await this.dispatchQuietly(fsm, 'JUDGEMENT_STORED');
  }

  /**
   * Round-verdict push (TDD §8/§9): one `judgement` frame to host + players
   * once judging completes. Anonymity ends here by design — nicknames are
   * joined server-side from the roster; clients never see pre-reveal owners.
   */
  private publishJudgement(code: string, judged: readonly JudgedEntry[]): void {
    if (this.hub === undefined || judged.length === 0) return;
    const room = this.opts.roomManager.get(code);
    const results = [...judged]
      .sort((a, b) => a.rank - b.rank)
      .map((entry) => ({
        rank: entry.rank,
        score: entry.score,
        title: entry.track.title,
        artist: entry.track.artist,
        explanation: entry.explanation,
        nickname: room?.players.get(entry.playerId)?.nickname ?? 'Mystery DJ',
      }));
    this.hub.publish(code, { t: 'judgement', payload: { results } });
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
