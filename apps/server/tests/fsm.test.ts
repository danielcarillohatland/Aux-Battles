/**
 * Phase-2 hard-case suite — FSM (testing-strategy §1 unit layer + §2 hard cases).
 *
 * Targets the table-driven engine (TDD §4, D-C):
 *  - every illegal `(state, event)` pair is REJECTED explicitly: state unchanged,
 *    no side-effect hook fired, rejection is a promise rejection — never a throw
 *    escaping dispatch();
 *  - TIMER_EXPIRED re-enters through the per-room async mutex and races
 *    (expiry vs host skip, double quorum fire) resolve to exactly ONE transition;
 *  - deadline math (`phaseEndsAt`) is pure arithmetic over fake time so no test
 *    ever sleeps real seconds (testing-strategy §2b timing note).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FSM_STATES } from '@aux/shared';
import { RoomFsm } from '../src/fsm/engine.js';
import { TRANSITIONS } from '../src/fsm/table.js';
import { IllegalTransitionError, type FsmChange, type FsmEvent } from '../src/fsm/types.js';

const ALL_EVENTS = [
  'START_GAME',
  'PICK_CATEGORY',
  'TIMER_EXPIRED',
  'SKIP_PHASE',
  'ALL_SUBMITTED',
  'BEGIN_PLAYBACK',
  'QUEUE_DONE',
  'JUDGEMENT_STORED',
  'ADVANCE_REVEAL',
  'NEXT_ROUND',
  'FINISH_GAME',
] as const satisfies readonly FsmEvent[];

/** Shortest legal event path from LOBBY into `state` (drives the matrix below). */
function pathTo(state: (typeof FSM_STATES)[number]): FsmEvent[] {
  const routes: Record<string, FsmEvent[]> = {
    LOBBY: [],
    CATEGORY: ['START_GAME'],
    SCENARIO: ['START_GAME', 'PICK_CATEGORY'],
    SONG_SELECTION: ['START_GAME', 'PICK_CATEGORY', 'SKIP_PHASE'],
    LOCKED: ['START_GAME', 'PICK_CATEGORY', 'SKIP_PHASE', 'TIMER_EXPIRED'],
    PLAYBACK: ['START_GAME', 'PICK_CATEGORY', 'SKIP_PHASE', 'TIMER_EXPIRED', 'BEGIN_PLAYBACK'],
    AI_JUDGING: [
      'START_GAME',
      'PICK_CATEGORY',
      'SKIP_PHASE',
      'TIMER_EXPIRED',
      'BEGIN_PLAYBACK',
      'QUEUE_DONE',
    ],
    RESULTS: [
      'START_GAME',
      'PICK_CATEGORY',
      'SKIP_PHASE',
      'TIMER_EXPIRED',
      'BEGIN_PLAYBACK',
      'QUEUE_DONE',
      'JUDGEMENT_STORED',
    ],
    LEADERBOARD: [
      'START_GAME',
      'PICK_CATEGORY',
      'SKIP_PHASE',
      'TIMER_EXPIRED',
      'BEGIN_PLAYBACK',
      'QUEUE_DONE',
      'JUDGEMENT_STORED',
      // RESULTS self-loops on ADVANCE_REVEAL until final:true…
      'ADVANCE_REVEAL',
    ],
    GAME_OVER: [
      'START_GAME',
      'PICK_CATEGORY',
      'SKIP_PHASE',
      'TIMER_EXPIRED',
      'BEGIN_PLAYBACK',
      'QUEUE_DONE',
      'JUDGEMENT_STORED',
      'ADVANCE_REVEAL',
      'FINISH_GAME',
    ],
  };
  return routes[state] ?? [];
}

async function fsmAt(state: (typeof FSM_STATES)[number], onChange?: (c: FsmChange) => void) {
  const fsm = new RoomFsm({ code: 'TST01', onChange });
  for (const ev of pathTo(state)) {
    await fsm.dispatch(ev, ev === 'ADVANCE_REVEAL' ? { final: true } : undefined);
  }
  return fsm;
}

describe('illegal transitions are rejected explicitly (table-driven)', () => {
  // The eyeballable truth: every pair NOT written in table.ts must bounce.
  const illegalPairs = FSM_STATES.flatMap((state) =>
    ALL_EVENTS.filter((event) => TRANSITIONS[state][event] === undefined).map((event) => ({
      state,
      event,
    })),
  );

  it('the table itself declares every legal pair exactly once per state', () => {
    // Guard against a typo'd duplicate key silently shadowing a row.
    for (const state of FSM_STATES) {
      const events = Object.keys(TRANSITIONS[state]);
      expect(new Set(events).size).toBe(events.length);
    }
  });

  it.each(illegalPairs.map((p) => [`${p.event} in ${p.state}`, p] as const))(
    'rejects %s with IllegalTransitionError and changes nothing',
    async (_label, { state, event }) => {
      const seen: FsmChange[] = [];
      const fsm = await fsmAt(state, (c) => seen.push(c));
      const before = { s: fsm.state, r: fsm.roundIdx, d: fsm.phaseEndsAt };
      const effectsBefore = seen.length; // setup path already fired legal hops

      // Rejected as a promise rejection — never a synchronous throw escaping.
      await expect(fsm.dispatch(event)).rejects.toBeInstanceOf(IllegalTransitionError);

      expect(fsm.state).toBe(state); // state unchanged…
      expect({ s: fsm.state, r: fsm.roundIdx, d: fsm.phaseEndsAt }).toEqual(before); // …fully
      expect(seen.length).toBe(effectsBefore); // no NEW side-effect intent emitted
    },
  );

  it('error records the offending pair and is named for upstream mapping (WRONG_PHASE)', async () => {
    const fsm = await fsmAt('LOBBY');
    let err: unknown;
    await fsm.dispatch('QUEUE_DONE').catch((e) => {
      err = e;
    });
    expect(err).toBeInstanceOf(IllegalTransitionError);
    const ile = err as IllegalTransitionError;
    expect(ile.state).toBe('LOBBY');
    expect(ile.event).toBe('QUEUE_DONE');
    expect(ile.name).toBe('IllegalTransitionError');
    expect(ile.message).toMatch(/illegal transition/i);
  });

  it('a rejected transition does not poison the mutex — later valid dispatch still lands', async () => {
    const fsm = await fsmAt('LOBBY');
    await expect(fsm.dispatch('FINISH_GAME')).rejects.toBeInstanceOf(IllegalTransitionError);
    await expect(fsm.dispatch('START_GAME')).resolves.toMatchObject({
      from: 'LOBBY',
      to: 'CATEGORY',
    });
  });
});

describe('valid transitions emit change intents + deadline math (fake clock)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-24T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('timed phases carry absolute deadlines from DEFAULT durations', async () => {
    const t0 = Date.now();
    const fsm = new RoomFsm({ code: 'TST01' });
    expect(fsm.state).toBe('LOBBY');
    expect(fsm.phaseEndsAt).toBeNull(); // idle room holds no deadline

    await fsm.dispatch('START_GAME');
    expect(fsm.phaseEndsAt).toBeNull(); // CATEGORY is host-gated

    await fsm.dispatch('PICK_CATEGORY');
    expect(fsm.state).toBe('SCENARIO');
    expect(fsm.phaseEndsAt).toBe(t0 + 8_000); // SCENARIO_DISPLAY_MS

    vi.advanceTimersByTime(3_000);
    await fsm.dispatch('TIMER_EXPIRED'); // → SONG_SELECTION
    expect(fsm.phaseEndsAt).toBe(t0 + 3_000 + 90_000); // SONG_SELECTION_MS

    await fsm.dispatch('TIMER_EXPIRED'); // → LOCKED
    expect(fsm.state).toBe('LOCKED');
    expect(fsm.phaseEndsAt).toBeNull(); // staging has no clock
  });

  it('host duration overrides replace defaults (host-adjustable selection window)', async () => {
    const fsm = new RoomFsm({
      code: 'TST01',
      durations: { SONG_SELECTION: 30_000 },
    });
    await fsm.dispatch('START_GAME');
    await fsm.dispatch('PICK_CATEGORY');
    const scenarioDeadline = fsm.phaseEndsAt;
    expect(scenarioDeadline).toBe(Date.now() + 8_000); // untouched phase keeps default

    await fsm.dispatch('SKIP_PHASE');
    expect(fsm.phaseEndsAt).toBe(Date.now() + 30_000); // override applied
  });

  it('RESULTS self-loops on ADVANCE_REVEAL and hops to LEADERBOARD only on final', async () => {
    const fsm = await fsmAt('RESULTS');
    await expect(fsm.dispatch('ADVANCE_REVEAL')).resolves.toMatchObject({
      from: 'RESULTS',
      to: 'RESULTS',
    });
    expect(fsm.state).toBe('RESULTS');

    await expect(fsm.dispatch('ADVANCE_REVEAL', { final: true })).resolves.toMatchObject({
      to: 'LEADERBOARD',
    });
    expect(fsm.state).toBe('LEADERBOARD');
  });

  it('roundIdx increments ONLY on LEADERBOARD --NEXT_ROUND-->', async () => {
    const fsm = await fsmAt('LEADERBOARD');
    expect(fsm.roundIdx).toBe(0);
    await fsm.dispatch('NEXT_ROUND');
    expect(fsm.roundIdx).toBe(1);
    expect(fsm.state).toBe('CATEGORY');
    // A full lap back to LEADERBOARD without NEXT_ROUND keeps the index.
    // (Already in CATEGORY after NEXT_ROUND — skip START_GAME in the replay.)
    for (const ev of pathTo('LEADERBOARD').slice(1)) {
      await fsm.dispatch(ev, ev === 'ADVANCE_REVEAL' ? { final: true } : undefined);
    }
    expect(fsm.roundIdx).toBe(1);
    await fsm.dispatch('NEXT_ROUND');
    expect(fsm.roundIdx).toBe(2);
  });
});

describe('hard case: mutex re-entry & races resolve to ONE transition', () => {
  /**
   * D-C: timer expiry re-enters the FSM THROUGH the room mutex. These tests
   * stand in for the TimerService callback by racing dispatches the way the
   * controller does — expiry vs host-skip arriving in the same tick.
   */

  it('timer expiry racing host skip serializes: first arrival wins, loser bounces benignly', async () => {
    const fsm = await fsmAt('SONG_SELECTION');

    // Same-tick race: neither caller awaits before the other is queued.
    const expiry = fsm.dispatch('TIMER_EXPIRED');
    const skip = fsm.dispatch('SKIP_PHASE');

    const results = await Promise.allSettled([expiry, skip]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1); // exactly ONE transition out of SONG_SELECTION
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(IllegalTransitionError);
    expect(fsm.state).toBe('LOCKED'); // both events target LOCKED; landed once
    expect(fsm.roundIdx).toBe(0);
  });

  it('double-fired ALL_SUBMITTED quorum trigger advances exactly one state', async () => {
    const seen: FsmChange[] = [];
    const fsm = await fsmAt('SONG_SELECTION', (c) => seen.push(c));

    // Controller bug / broadcast echo double-fire must not skip two phases
    // or call downstream side effects twice (testing-strategy §2a).
    const fires = Promise.allSettled([
      fsm.dispatch('ALL_SUBMITTED'),
      fsm.dispatch('ALL_SUBMITTED'),
    ]);
    const results = await fires;
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(fsm.state).toBe('LOCKED');
    expect(seen.length).toBe(3 + 1); // 3 setup hops + exactly ONE quorum transition
  });

  it('slow awaited onChange blocks later dispatches — ordering stays deterministic', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const order: string[] = [];
    const fsm = new RoomFsm({
      code: 'TST01',
      onChange: async (c) => {
        order.push(`effect:${c.event}`);
        if (c.event === 'START_GAME') await gate; // simulate slow snapshot broadcast
      },
    });

    const first = fsm.dispatch('START_GAME').then((c) => {
      order.push(`resolved:${c.event}`);
      return c;
    });
    const second = fsm.dispatch('PICK_CATEGORY').then(
      (c) => {
        order.push(`resolved:${c.event}`);
        return c;
      },
      (e) => {
        order.push(`rejected`);
        throw e;
      },
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['effect:START_GAME']); // second dispatch held behind the mutex

    release();
    await Promise.all([first, second]);
    // The mutex hands over only AFTER the first hop's effects settle; the
    // second dispatch then transitions and runs its own effect before either
    // caller's outer .then bookkeeping observes resolution order.
    expect(order).toEqual([
      'effect:START_GAME',
      'resolved:START_GAME',
      'effect:PICK_CATEGORY',
      'resolved:PICK_CATEGORY',
    ]);
    expect(fsm.state).toBe('SCENARIO');
  });

  it('an onChange failure surfaces to that caller but never wedges the room', async () => {
    const boom = new Error('broadcast socket gone');
    let calls = 0;
    const fsm = new RoomFsm({
      code: 'TST01',
      onChange: async () => {
        calls += 1;
        if (calls === 1) throw boom;
      },
    });

    await expect(fsm.dispatch('START_GAME')).rejects.toBe(boom);
    await expect(fsm.dispatch('PICK_CATEGORY')).resolves.toMatchObject({ to: 'SCENARIO' });
    expect(calls).toBe(2);
    expect(fsm.state).toBe('SCENARIO');
  });

  it('a stale armed timer never double-fires after re-arm (TimerService guard)', async () => {
    vi.useFakeTimers();
    try {
      const { TimerService } = await import('../src/core/timers.js');
      const timers = new TimerService();
      const fired: string[] = [];

      // SCENARIO phase armed; host skips; controller re-arms for SONG_SELECTION.
      const scenarioDeadline = Date.now() + 8_000;
      timers.arm('TST01', scenarioDeadline, () => fired.push('scenario-expiry'));
      const skipAt = Date.now() + 3_000;
      vi.setSystemTime(skipAt);
      const selectionDeadline = skipAt + 90_000;
      timers.arm('TST01', selectionDeadline, () => fired.push('selection-expiry'));

      // The OLD deadline passes — its callback must be dead, not queued.
      vi.advanceTimersByTime(scenarioDeadline - skipAt + 1);
      await vi.advanceTimersByTimeAsync(0);
      expect(fired).toEqual([]);
      expect(timers.deadlineOf('TST01')).toBe(selectionDeadline);

      // The LIVE deadline fires exactly once, through the mutex as a task.
      let fsmHits = 0;
      const fsm = await fsmAt('SONG_SELECTION');
      timers.disarmAll();
      timers.arm('TST02', Date.now() + 5_000, () => {
        fsmHits += 1;
        void fsm.dispatch('TIMER_EXPIRED').catch(() => {}); // benign if raced
      });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(fired).toEqual([]); // stale callback still silent
      expect(fsmHits).toBe(1); // exactly one expiry…
      expect(fsm.state).toBe('LOCKED'); // …one transition
      expect(timers.size).toBe(0); // fired timer cleaned up
    } finally {
      vi.useRealTimers();
    }
  });

  it('an already-overdue deadline (boot sweep after crash) fires via the mutex, not synchronously', async () => {
    vi.useFakeTimers();
    try {
      const { TimerService } = await import('../src/core/timers.js');
      const timers = new TimerService();
      const fsm = new RoomFsm({ code: 'TST01' });
      await fsm.dispatch('START_GAME');
      await fsm.dispatch('PICK_CATEGORY'); // SCENARIO armed

      // Crash-restart simulation: wall clock moved past the persisted deadline.
      vi.setSystemTime((fsm.phaseEndsAt ?? 0) + 500);

      let expired = false;
      timers.arm('TST01', fsm.phaseEndsAt!, () => {
        expired = true;
        void fsm.dispatch('TIMER_EXPIRED').catch(() => {});
      });

      expect(expired).toBe(false); // setTimeout(0), never synchronous —
      expect(fsm.state).toBe('SCENARIO'); // the mutex must stay free to serialize
      await vi.advanceTimersByTimeAsync(0);
      expect(expired).toBe(true);
      expect(fsm.state).toBe('SONG_SELECTION');
      expect(fsm.phaseEndsAt).toBe(Date.now() + 90_000); // fresh phase armed post-catch-up
    } finally {
      vi.useRealTimers();
    }
  });

  it('SKIP_PHASE and TIMER_EXPIRED target the same states — either exit path lands identically', async () => {
    const viaSkip = await fsmAt('SCENARIO');
    await viaSkip.dispatch('SKIP_PHASE');
    const viaTimer = await fsmAt('SCENARIO');
    await viaTimer.dispatch('TIMER_EXPIRED');
    expect(viaSkip.state).toBe(viaTimer.state);
    expect(viaSkip.phaseEndsAt).not.toBeNull();
  });
});
