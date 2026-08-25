/**
 * RoomFsm — table-driven room state machine (TDD §4, D-C).
 *
 * Design invariants from the spec:
 *  - Literal adjacency table (`table.ts`); illegal `(state, event)` pairs are
 *    rejected with IllegalTransitionError and change nothing.
 *  - Side effects are isolated: the engine only moves state + computes the new
 *    phase deadline; everything else (snapshot broadcast, timer arming,
 *    checkpoint write per D-B) happens in the awaited `onChange` hook, so
 *    ordering of broadcasts stays deterministic.
 *  - A per-room async MUTEX serializes every dispatch (timer expiry vs host
 *    skip races resolve strictly in arrival order).
 *
 * Timed phases carry `phaseEndsAt` (absolute epoch-ms) after every transition;
 * snapshots expose it and clients render countdowns locally (drift-proof, D-C).
 */
import type { FsmState } from '@aux/shared';
import { DEFAULT_PHASE_DURATIONS, TRANSITIONS } from './table.js';
import {
  IllegalTransitionError,
  type ChangeHandler,
  type FsmChange,
  type FsmEvent,
  type TransitionPayload,
} from './types.js';

export interface RoomFsmOptions {
  /** Room code stamped on every change record. */
  code: string;
  initial?: FsmState;
  roundIdx?: number;
  /** Host-adjustable duration overrides merged over DEFAULT_PHASE_DURATIONS. */
  durations?: Partial<Record<FsmState, number>>;
  /** Awaited side-effect hook, run inside the mutex after each hop. */
  onChange?: ChangeHandler | undefined;
}

export class RoomFsm {
  private _state: FsmState;
  private _roundIdx: number;
  private _phaseEndsAt: number | null = null;

  /** The per-room async mutex: every dispatch chains onto this promise. */
  private mutex: Promise<unknown> = Promise.resolve();

  private readonly durations: Partial<Record<FsmState, number>>;
  private readonly onChange?: ChangeHandler;
  public readonly code: string;

  constructor(opts: RoomFsmOptions) {
    this.code = opts.code;
    this._state = opts.initial ?? 'LOBBY';
    this._roundIdx = opts.roundIdx ?? 0;
    this.durations = { ...DEFAULT_PHASE_DURATIONS, ...opts.durations };
    if (opts.onChange !== undefined) this.onChange = opts.onChange;
    this._phaseEndsAt = this.deadlineFor(this._state);
  }

  get state(): FsmState {
    return this._state;
  }

  get roundIdx(): number {
    return this._roundIdx;
  }

  /** Absolute epoch-ms deadline of the current timed phase, or null. */
  get phaseEndsAt(): number | null {
    return this._phaseEndsAt;
  }

  /** Is `(state, event)` legal? Pure read — used by host-control guards. */
  can(event: FsmEvent): boolean {
    return TRANSITIONS[this._state][event] !== undefined;
  }

  /**
   * Serialized by the room mutex. Resolves with the change record AFTER the
   * onChange side effects have settled; rejects with IllegalTransitionError
   * without touching state when the pair is not in the table.
   */
  dispatch(event: FsmEvent, payload?: TransitionPayload): Promise<FsmChange> {
    const run = this.mutex.then(
      () => this.applyAndNotify(event, payload),
      // Never let one caller's rejection break serialization for the rest.
      () => this.applyAndNotify(event, payload),
    );
    this.mutex = run.catch(() => undefined);
    return run;
  }

  /** Runs inside the mutex: transition, then awaited side-effect hook. */
  private async applyAndNotify(event: FsmEvent, payload?: TransitionPayload): Promise<FsmChange> {
    const change = this.apply(event, payload);
    if (this.onChange !== undefined) await this.onChange(change);
    return change;
  }

  /** Caller-inside-mutex transition. Private: all entry is via dispatch(). */
  private apply(event: FsmEvent, payload?: TransitionPayload): FsmChange {
    const target = TRANSITIONS[this._state][event];
    if (target === undefined) throw new IllegalTransitionError(this._state, event);

    const from = this._state;
    const to = typeof target === 'function' ? target(payload ?? {}) : target;

    // NEXT_ROUND starts a fresh round; staying within a round keeps the index.
    if (from === 'LEADERBOARD' && event === 'NEXT_ROUND') this._roundIdx += 1;

    this._state = to;
    this._phaseEndsAt = this.deadlineFor(to);

    const change: FsmChange = {
      code: this.code,
      from,
      to,
      event,
      roundIdx: this._roundIdx,
      phaseEndsAt: this._phaseEndsAt,
    };
    if (payload !== undefined) change.payload = payload;
    return change;
  }

  /** Deadline for a freshly-entered state; null for non-timed states. */
  private deadlineFor(state: FsmState): number | null {
    const ms = this.durations[state];
    return ms === undefined ? null : Date.now() + ms;
  }
}
