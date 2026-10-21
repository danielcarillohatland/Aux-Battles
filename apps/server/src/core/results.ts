/**
 * ResultsStore — Phase 4 judgement persistence + leaderboard math (TDD §6).
 *
 * Owns the two §6 tables' semantics behind in-memory maps that ride the SAME
 * RoomStore checkpoint pattern as core/submissions.ts (D-B): authoritative
 * state lives IN MEMORY here; `serialize(code)` produces a versioned payload
 * fragment that the composition root merges into the room checkpoint, and
 * `hydrate(payload)` restores it during lazy rehydration. A crash therefore
 * costs at most the last un-checkpointed transition — never an awarded round.
 *
 * Data model (TDD §6, document-shaped until the stage-1 SQLite swap):
 *   results             → StoredJudgement keyed by roundId (`code:idx`),
 *                         identified within the round by trackId:
 *                         { roundId, trackId, score, rank, explanation,
 *                           judgeModel }
 *   leaderboard_entries → LeaderboardEntry { playerId, points, wins },
 *                         aggregated ACROSS rounds per room by joining each
 *                         round's judgements back to submissions (trackId →
 *                         playerId). Points are BY RANK, not judge scores:
 *                         1st = 5 pts + 1 win · 2nd = 3 · 3rd = 2 · else 1.
 *
 * ANONYMITY note (D-D): judgements carry no identity beyond what judging
 * already produced; the leaderboard is keyed by internal playerId and callers
 * resolve nicknames at the presentation edge (orchestrator snapshot builder).
 */
import type { Track } from '@aux/shared';
import type { JudgedEntry } from '../judge/judge-service.js';

/** Composite round identity — same `${code}:${idx}` convention as submissions. */
export function resultRoundKeyOf(code: string, roundIdx: number): string {
  return `${code}:${roundIdx}`;
}

/** Points awarded by finishing rank (TDD §6 leaderboard_entries.points). */
export const POINTS_BY_RANK: readonly number[] = [5, 3, 2];
export const POINTS_FOR_UNPLACED = 1;

/** Rank → points: 1st=5, 2nd=3, 3rd=2, every other rank=1. */
export function pointsForRank(rank: number): number {
  return POINTS_BY_RANK[rank - 1] ?? POINTS_FOR_UNPLACED;
}

/**
 * One stored judgement row — mirrors the §6 `results` table exactly, keyed by
 * composite roundId instead of a foreign key. One row per judged TRACK.
 */
export interface StoredJudgement {
  /** `${code}:${roundIdx}` */
  roundId: string;
  /** Track identity within the round (join key to submissions.track.id). */
  trackId: string;
  /** Judge's 0–100 quality score (display-only; NOT the scoring currency). */
  score: number;
  /** 1-based finishing position, tie-free per judge validation. */
  rank: number;
  /** Judge bullets joined into prose, sanitized/clamped by the judge service. */
  explanation: string;
  /** Which model produced it ('fallback-hash' on degradation). */
  judgeModel: string;
}

/** Aggregated §6 `leaderboard_entries` row for one player in one room. */
export interface LeaderboardEntry {
  playerId: string;
  /** Cumulative rank points across all judged rounds. */
  points: number;
  /** Count of 1st-place finishes across all judged rounds. */
  wins: number;
}

/** Checkpoint payload fragment (versioned for forward-compatible swaps). */
export interface ResultsPayload {
  version: 1;
  /** roundId → stored judgements, in recorded (worst-first reveal) order. */
  rounds: Record<string, StoredJudgement[]>;
}

/**
 * Read seam satisfied structurally by core/submissions.ts (SubmissionStore).
 * Only the join surface is exposed — count/hasSubmitted stay out of scope.
 */
export interface SubmissionRoundsView {
  list(roundId: string): Array<{ playerId: string; track: Track }>;
}

/**
 * Read-only view of this store for consumers (orchestrator, future routes),
 * mirroring the SubmissionStoreView seam pattern from round-orchestrator.ts.
 */
export interface ResultsStoreView {
  /** Stored judgements for one round, reveal order (worst first). */
  list(roundId: string): StoredJudgement[];
  count(roundId: string): number;
  /** Sorted cumulative standings for a room (points desc, wins desc). */
  leaderboard(roomCode: string): LeaderboardEntry[];
}

/** Deterministic tiebreak beyond wins so equal boards sort stably. */
function compareEntries(a: LeaderboardEntry, b: LeaderboardEntry): number {
  return b.points - a.points || b.wins - a.wins || (a.playerId < b.playerId ? -1 : 1);
}

export class ResultsStore {
  /** roundId → judgements, kept in recorded order (reveal walks it directly). */
  private readonly byRound = new Map<string, StoredJudgement[]>();

  /**
   * Controller seam (D-B), matching SubmissionStore.onChanged: fired with the
   * ROOM CODE after every mutation so the composition root merges serialize()
   * into the checkpoint. Never throws inward — checkpointing must not break
   * the JUDGEMENT_STORED dispatch mid-party.
   */
  onChanged: ((code: string) => void) | null = null;

  constructor(private readonly submissions?: SubmissionRoundsView | undefined) {}

  private fire(code: string): void {
    if (this.onChanged === null) return;
    try {
      this.onChanged(code);
    } catch {
      // Persistence failure must never invalidate stored judgements (class doc).
    }
  }

  /**
   * Record one round's full judgement set (the judge service is batched — all
   * rows arrive together). Re-recording a round REPLACES its rows, so a retry
   * after a crash between record and JUDGEMENT_STORED stays idempotent.
   * Returns the stored rows in reveal order (worst rank first), matching the
   * orchestrator's reveal choreography.
   */
  record(code: string, roundIdx: number, judged: readonly JudgedEntry[]): StoredJudgement[] {
    const roundId = resultRoundKeyOf(code, roundIdx);
    const worstFirst = [...judged].sort((a, b) => b.rank - a.rank);
    const rows = worstFirst.map((entry) => ({
      roundId,
      trackId: entry.track.id,
      score: entry.score,
      rank: entry.rank,
      explanation: entry.explanation,
      judgeModel: entry.judgeModel,
    }));
    this.byRound.set(roundId, rows);
    if (rows.length > 0) this.fire(code);
    return rows.map((row) => ({ ...row }));
  }

  list(roundId: string): StoredJudgement[] {
    const rows = this.byRound.get(roundId);
    return rows === undefined ? [] : rows.map((row) => ({ ...row }));
  }

  count(roundId: string): number {
    return this.byRound.get(roundId)?.length ?? 0;
  }

  /** Every recorded roundId of this room, ascending by round index. */
  roundIdsOf(code: string): string[] {
    const prefix = `${code}:`;
    return [...this.byRound.keys()]
      .filter((roundId) => roundId.startsWith(prefix))
      .sort((a, b) => Number(a.slice(prefix.length)) - Number(b.slice(prefix.length)));
  }

  /**
   * Cumulative §6 standings keyed by playerId: each round's judgements are
   * joined back to that round's submissions (trackId → playerId), then ranked
   * points and wins accumulate across ALL recorded rounds. Sorted best-first.
   * Requires the submissions view; without it there is nothing to join and the
   * board is empty (judgement rows themselves remain intact).
   */
  leaderboard(roomCode: string): LeaderboardEntry[] {
    if (this.submissions === undefined) return [];
    const board = new Map<string, LeaderboardEntry>();
    for (const roundId of this.roundIdsOf(roomCode)) {
      const owners = new Map<string, string>(); // trackId → playerId (first submitter wins)
      for (const sub of this.submissions.list(roundId)) {
        if (!owners.has(sub.track.id)) owners.set(sub.track.id, sub.playerId);
      }
      for (const row of this.byRound.get(roundId) ?? []) {
        const playerId = owners.get(row.trackId);
        if (playerId === undefined) continue; // orphaned judgement (submission evicted)
        const current = board.get(playerId) ?? { playerId, points: 0, wins: 0 };
        if (row.judgeModel !== 'crowd-no-votes') current.points += pointsForRank(row.rank);
        if (row.rank === 1 && row.judgeModel !== 'crowd-no-votes') current.wins += 1;
        board.set(playerId, current);
      }
    }
    return [...board.values()].sort(compareEntries);
  }

  /** Drop a room's rounds entirely (room close / TTL eviction symmetry). */
  clearRoom(code: string): void {
    for (const roundId of this.roundIdsOf(code)) this.byRound.delete(roundId);
  }

  /** Checkpoint fragment covering every round of this room (embedded by controller). */
  serialize(code: string): ResultsPayload {
    const rounds: Record<string, StoredJudgement[]> = {};
    for (const roundId of this.roundIdsOf(code)) {
      rounds[roundId] = this.byRound.get(roundId)!;
    }
    return { version: 1, rounds };
  }

  /** Restore serialized rounds during lazy rehydration. Replaces prior data wholesale. */
  hydrate(payload: ResultsPayload | null | undefined): void {
    if (payload === null || payload === undefined || payload.version !== 1) return;
    for (const [roundId, rows] of Object.entries(payload.rounds)) {
      this.byRound.set(
        roundId,
        rows.map((row) => ({ ...row })),
      );
    }
  }
}
