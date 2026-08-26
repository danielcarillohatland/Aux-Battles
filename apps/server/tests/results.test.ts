import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Track } from '@aux/shared';
import { SubmissionStore } from '../src/core/submissions.js';
import {
  POINTS_BY_RANK,
  ResultsStore,
  pointsForRank,
  resultRoundKeyOf,
} from '../src/core/results.js';
import type { JudgedEntry } from '../src/judge/judge-service.js';
import { SqliteRoomStore } from '../src/core/room-store.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const track = (id: string): Track => ({ id, title: `T ${id}`, artist: 'A', durationMs: 180_000 });

function judged(playerId: string, trackId: string, over: Partial<JudgedEntry> = {}): JudgedEntry {
  return {
    playerId,
    track: track(trackId),
    chicken: false,
    rank: 1,
    score: 90,
    explanation: 'fit the moment',
    judgeModel: 'test-model',
    ...over,
  };
}

describe('rank-points math (TDD §6 leaderboard_entries)', () => {
  it('awards 5/3/2 by podium rank and 1 point otherwise', () => {
    expect(POINTS_BY_RANK).toEqual([5, 3, 2]);
    expect(pointsForRank(1)).toBe(5);
    expect(pointsForRank(2)).toBe(3);
    expect(pointsForRank(3)).toBe(2);
    for (const rank of [4, 5, 8, 99]) expect(pointsForRank(rank)).toBe(1);
  });
});

describe('ResultsStore judgement rows (TDD §6 results)', () => {
  it('stores rows keyed by roundId with exactly the §6 columns, reveal order first', () => {
    const store = new ResultsStore();
    const code = 'ABCDE';
    const rows = store.record(code, 0, [
      judged('p1', 't1', { rank: 2, score: 70 }),
      judged('p2', 't2', { rank: 1, score: 95 }),
    ]);
    expect(resultRoundKeyOf(code, 0)).toBe(`${code}:0`);
    // Worst-first: the reveal walks this order and lands on the winner last.
    expect(rows).toEqual([
      {
        roundId: `${code}:0`,
        trackId: 't1',
        score: 70,
        rank: 2,
        explanation: 'fit the moment',
        judgeModel: 'test-model',
      },
      {
        roundId: `${code}:0`,
        trackId: 't2',
        score: 95,
        rank: 1,
        explanation: 'fit the moment',
        judgeModel: 'test-model',
      },
    ]);
    expect(store.list(`${code}:0`)).toEqual(rows);
    expect(store.count(`${code}:0`)).toBe(2);
    expect(store.list('ZZZZZ:0')).toEqual([]);
  });

  it('re-recording a round replaces its rows (idempotent retry after crash)', () => {
    const store = new ResultsStore();
    store.record('ABCDE', 0, [judged('p1', 't1', { rank: 1 })]);
    store.record('ABCDE', 0, [judged('p1', 't9', { rank: 1, score: 42 })]);
    expect(store.count('ABCDE:0')).toBe(1);
    expect(store.list('ABCDE:0')[0]?.trackId).toBe('t9');
  });

  it('fires onChanged with the room code on mutation', () => {
    const store = new ResultsStore();
    const seen: string[] = [];
    store.onChanged = (code) => seen.push(code);
    store.record('ABCDE', 0, [judged('p1', 't1')]);
    expect(seen).toEqual(['ABCDE']);
  });
});

describe('leaderboard(roomCode) — join submissions → playerId', () => {
  it('accumulates rank points and wins across rounds, sorted best-first', () => {
    const subs = new SubmissionStore();
    const store = new ResultsStore(subs);

    // Round 0: p1 wins, p2 second, p3 third.
    subs.submit({
      code: 'ABCDE',
      roundIdx: 0,
      playerId: 'p1',
      clientMsgId: 'm1',
      track: track('t1'),
    });
    subs.submit({
      code: 'ABCDE',
      roundIdx: 0,
      playerId: 'p2',
      clientMsgId: 'm2',
      track: track('t2'),
    });
    subs.submit({
      code: 'ABCDE',
      roundIdx: 0,
      playerId: 'p3',
      clientMsgId: 'm3',
      track: track('t3'),
    });
    store.record('ABCDE', 0, [
      judged('x', 't1', { rank: 1 }),
      judged('y', 't2', { rank: 2 }),
      judged('z', 't3', { rank: 3 }),
    ]);

    // Round 1: p2 wins, p4 fourth.
    subs.submit({
      code: 'ABCDE',
      roundIdx: 1,
      playerId: 'p2',
      clientMsgId: 'n1',
      track: track('u2'),
    });
    subs.submit({
      code: 'ABCDE',
      roundIdx: 1,
      playerId: 'p4',
      clientMsgId: 'n2',
      track: track('u4'),
    });
    store.record('ABCDE', 1, [
      judged('y', 'u2', { rank: 1, score: 80 }),
      judged('w', 'u4', { rank: 4, score: 10 }),
    ]);

    // Points by rank across BOTH rounds, keyed by playerId:
    expect(store.leaderboard('ABCDE')).toEqual([
      { playerId: 'p2', points: 5 + 3, wins: 1 }, // 2nd r0 + 1st r1
      { playerId: 'p1', points: 5, wins: 1 },
      { playerId: 'p3', points: 2, wins: 0 },
      { playerId: 'p4', points: 1, wins: 0 },
    ]);
  });

  it('skips orphaned judgements whose submission vanished and sorts ties deterministically', () => {
    const subs = new SubmissionStore();
    const store = new ResultsStore(subs);
    subs.submit({
      code: 'ABCDE',
      roundIdx: 0,
      playerId: 'pa',
      clientMsgId: 'm1',
      track: track('ta'),
    });
    subs.submit({
      code: 'ABCDE',
      roundIdx: 0,
      playerId: 'pb',
      clientMsgId: 'm2',
      track: track('tb'),
    });
    store.record('ABCDE', 0, [
      judged('x', 'ghost-track', { rank: 1 }), // no matching submission
      judged('y', 'ta', { rank: 2 }),
      judged('z', 'tb', { rank: 3 }),
    ]);
    expect(store.leaderboard('ABCDE')).toEqual(
      [
        { playerId: 'pb', points: 2, wins: 0 }, // tie on points broken by wins→playerId
        { playerId: 'pa', points: 3, wins: 0 },
      ].sort((a, b) => b.points - a.points || a.playerId.localeCompare(b.playerId)),
    );
  });

  it('returns an empty board without a submissions view (nothing to join)', () => {
    const store = new ResultsStore();
    store.record('ABCDE', 0, [judged('p1', 't1')]);
    expect(store.leaderboard('ABCDE')).toEqual([]);
  });

  it('clearRoom drops only that room’s rounds', () => {
    const store = new ResultsStore();
    store.record('ABCDE', 0, [judged('p1', 't1')]);
    store.record('FGHIJ', 0, [judged('p2', 't2')]);
    store.clearRoom('ABCDE');
    expect(store.count('ABCDE:0')).toBe(0);
    expect(store.count('FGHIJ:0')).toBe(1);
  });
});

describe('checkpoint survival (RoomStore pattern, TDD §11 tmpfile)', () => {
  it('judgements + standings are identical after a full store close/reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aux-results-'));
    dirs.push(dir);
    const db = join(dir, 'rooms.sqlite');

    const subsBefore = new SubmissionStore();
    const resultsBefore = new ResultsStore(subsBefore);
    subsBefore.submit({
      code: 'KLMNO',
      roundIdx: 0,
      playerId: 'p1',
      clientMsgId: 'm1',
      track: track('t1'),
    });
    subsBefore.submit({
      code: 'KLMNO',
      roundIdx: 0,
      playerId: 'p2',
      clientMsgId: 'm2',
      track: track('t2'),
    });
    resultsBefore.record('KLMNO', 0, [
      judged('x', 't1', { rank: 1 }),
      judged('y', 't2', { rank: 2 }),
    ]);
    const beforeBoard = resultsBefore.leaderboard('KLMNO');

    // Composition-root merge shape: submissions + results fragments into ONE
    // opaque RoomStore document (same pattern as game-runtimes persist()).
    const first = new SqliteRoomStore(db);
    first.put('KLMNO', {
      fsmState: 'LEADERBOARD',
      roundIdx: 0,
      phaseEndsAt: null,
      room: null,
      submissions: subsBefore.serialize('KLMNO'),
      results: resultsBefore.serialize('KLMNO'),
    });
    first.close();

    // Restart: lazy rehydration rebuilds both stores from the checkpoint.
    const second = new SqliteRoomStore(db);
    const snap = second.get('KLMNO')!;
    const cp = snap.state as {
      submissions: ReturnType<SubmissionStore['serialize']>;
      results: ReturnType<ResultsStore['serialize']>;
    };
    const subsAfter = new SubmissionStore();
    const resultsAfter = new ResultsStore(subsAfter);
    subsAfter.hydrate(cp.submissions);
    resultsAfter.hydrate(cp.results);
    second.close();

    expect(resultsAfter.list('KLMNO:0')).toEqual(resultsBefore.list('KLMNO:0'));
    expect(resultsAfter.leaderboard('KLMNO')).toEqual(beforeBoard);
    expect(beforeBoard).toEqual([
      { playerId: 'p1', points: 5, wins: 1 },
      { playerId: 'p2', points: 3, wins: 0 },
    ]);
  });

  it('hydrating legacy checkpoints without a results fragment is a no-op', () => {
    const store = new ResultsStore(new SubmissionStore());
    store.hydrate(undefined);
    store.hydrate(null);
    store.hydrate({ version: 2 } as never); // future version ignored, not thrown
    expect(store.count('ABCDE:0')).toBe(0);
  });
});
