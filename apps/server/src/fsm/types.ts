/**
 * FSM vocabulary (TDD §4). States come from @aux/shared constants — the single
 * protocol truth. Events name the CAUSE of a transition (host action, timer,
 * quorum, async job), never the destination, so the table below stays literal.
 */

import type { FsmState } from '@aux/shared';

export const FSM_EVENTS = [
  'START_GAME', // host presses Start            (LOBBY → CATEGORY)
  'PICK_CATEGORY', // host picks category          (CATEGORY → SCENARIO)
  'TIMER_EXPIRED', // armed deadline fired (D-C)   (SCENARIO/SONG_SELECTION exits)
  'SKIP_PHASE', // host skips current phase        (same targets as TIMER_EXPIRED)
  'ALL_SUBMITTED', // quorum early-fire             (SONG_SELECTION → LOCKED)
  'BEGIN_PLAYBACK', // host taps Play (staging)    (LOCKED → PLAYBACK)
  'QUEUE_DONE', // all songs played                 (PLAYBACK → AI_JUDGING)
  'JUDGEMENT_STORED', // validated judgement saved  (AI_JUDGING → RESULTS)
  'ADVANCE_REVEAL', // host advances / auto-timer   (RESULTS ↺ | → LEADERBOARD)
  'NEXT_ROUND', // host presses Next Round          (LEADERBOARD → CATEGORY)
  'FINISH_GAME', // host presses Finish             (LEADERBOARD → GAME_OVER)
] as const;

export type FsmEvent = (typeof FSM_EVENTS)[number];

/** Optional per-event data carried into the change record. */
export interface TransitionPayload {
  /** Category chosen by the host (PICK_CATEGORY). */
  category?: string;
  /** True when ADVANCE_REVEAL just revealed the winner → hop to LEADERBOARD. */
  final?: boolean;
}

/** Immutable record handed to the onChange side-effect hook after each hop. */
export interface FsmChange {
  code: string;
  from: FsmState;
  to: FsmState;
  event: FsmEvent;
  roundIdx: number;
  /** Absolute epoch-ms deadline for the NEW state's timed phase, else null (D-C). */
  phaseEndsAt: number | null;
  payload?: TransitionPayload;
}

export type ChangeHandler = (change: FsmChange) => void | Promise<void>;

/** Raised when `(state, event)` is not in the adjacency table. */
export class IllegalTransitionError extends Error {
  constructor(
    public readonly state: FsmState,
    public readonly event: FsmEvent,
  ) {
    super(`illegal transition: ${event} in ${state}`);
    this.name = 'IllegalTransitionError';
  }
}
