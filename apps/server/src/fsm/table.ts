/**
 * The transition table — a literal adjacency map (TDD §4: "~80 lines, hand-rolled").
 * Every legal `(state, event)` pair is written out; anything absent is illegal
 * and rejected by the engine. Targets are either a fixed state or, for the
 * multi-step RESULTS reveal, a pure function of the payload — the PAIR itself
 * is still declared here, so the table remains the complete truth.
 *
 * Note: AI_JUDGING has NO self-exit for its 20 s timeout. The timeout is just a
 * deadline like any other (see TIMED_PHASES): expiry fires the controller's
 * callback, which runs the fallback judge and dispatches JUDGEMENT_STORED
 * (TDD §8). The FSM never knows a judge exists.
 */
import type { FsmState } from '@aux/shared';
import { AI_JUDGING_TIMEOUT_MS, SCENARIO_DISPLAY_MS, SONG_SELECTION_MS } from '@aux/shared';
import type { FsmEvent, TransitionPayload } from './types.js';

type Target = FsmState | ((payload: TransitionPayload) => FsmState);

export const TRANSITIONS: Readonly<Record<FsmState, Partial<Record<FsmEvent, Target>>>> = {
  LOBBY: { START_GAME: 'CATEGORY' },
  CATEGORY: { PICK_CATEGORY: 'SCENARIO' },
  SCENARIO: { TIMER_EXPIRED: 'SONG_SELECTION', SKIP_PHASE: 'SONG_SELECTION' },
  SONG_SELECTION: {
    TIMER_EXPIRED: 'LOCKED',
    SKIP_PHASE: 'LOCKED',
    ALL_SUBMITTED: 'LOCKED',
  },
  LOCKED: { BEGIN_PLAYBACK: 'PLAYBACK' },
  PLAYBACK: { QUEUE_DONE: 'AI_JUDGING' },
  AI_JUDGING: { JUDGEMENT_STORED: 'RESULTS' },
  RESULTS: {
    ADVANCE_REVEAL: (p) => (p.final === true ? 'LEADERBOARD' : 'RESULTS'),
  },
  LEADERBOARD: { NEXT_ROUND: 'CATEGORY', FINISH_GAME: 'GAME_OVER' },
  GAME_OVER: {},
};

/**
 * Default phase durations (epoch-ms offsets) for states that carry a deadline
 * clients render locally (D-C). Host-adjustable overrides live in RoomFsm opts.
 * PLAYBACK is intentionally absent — it ends on provider events / host taps.
 */
export const DEFAULT_PHASE_DURATIONS: Readonly<Partial<Record<FsmState, number>>> = {
  SCENARIO: SCENARIO_DISPLAY_MS,
  SONG_SELECTION: SONG_SELECTION_MS,
  AI_JUDGING: AI_JUDGING_TIMEOUT_MS,
};
