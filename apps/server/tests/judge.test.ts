/**
 * Phase-4 judge property tests (TDD §8/§11): permutation/coverage/clamp
 * invariants over randomized rounds, fallback determinism, malformed-output
 * retry ladder — plus the orchestrator wiring smoke (judgeRound behind the
 * LLMProvider seam, ResultsStore persistence, `judgement` WS broadcast).
 */
import { describe, expect, it } from 'vitest';
import type { Track } from '@aux/shared';
import {
  RoundOrchestrator,
  roundIdOf,
  type SubmissionStoreView,
} from '../src/core/round-orchestrator.js';
import { ResultsStore } from '../src/core/results.js';
import { RoomManager } from '../src/core/room-manager.js';
import type { StoredSubmission } from '../src/core/submissions.js';
import type {
  LLMProvider,
  LlmCompleteRequest,
  LlmCompleteResponse,
} from '../src/judge/llm-provider.js';
import { FALLBACK_MODEL, judgeRound } from '../src/judge/service.js';
import { RoomFsm } from '../src/fsm/engine.js';
import type { PushFrame, WsHub, WsViewer } from '../src/ws/types.js';

// ── Deterministic randomness (seeded; CI-stable) ─────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleWith<T>(items: T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

interface SongSpec {
  id: string;
  title: string;
  artist: string;
}

/** Random song batch: sizes 1..12, noisy unicode-ish titles/artists. */
function randomSongs(rand: () => number): SongSpec[] {
  const n = 1 + Math.floor(rand() * 12);
  return Array.from({ length: n }, (_, i) => ({
    id: `t${i}-${Math.floor(rand() * 1e9)}`,
    title: [`Song ${i}`, 'DJ "$hadow"', 'line\nbreak', 'emoji 🎉 pick'][Math.floor(rand() * 4)]!,
    artist: [`Artist ${i}`, 'The 1975', 'Sigur Rós'][Math.floor(rand() * 3)]!,
  }));
}

/** Attach the 0-based songIndex the judge contract keys results by. */
const numbered = (songs: readonly SongSpec[]) => songs.map((song, index) => ({ ...song, index }));

// ── Provider doubles ──────────────────────────────────────────────────────────

type Row = { songIndex: number; score: number; explanation: string };

/** Serves the given rows per call (cycled), wrapped as an LLM response. */
function scriptedProvider(script: Row[][], model = 'test-model'): LLMProvider {
  let call = 0;
  return {
    async complete(): Promise<LlmCompleteResponse> {
      const rows = script[Math.min(call, script.length - 1)]!;
      call += 1;
      return { text: JSON.stringify({ judgements: rows }), model };
    },
  };
}

/** Valid full-coverage judgement for one song batch, scores by spec order. */
function fullCoverage(songs: readonly SongSpec[], scores: readonly number[]): Row[] {
  return songs.map((song, i) => ({
    songIndex: i,
    score: scores[i % scores.length]!,
    explanation: `verdict ${i}`,
  }));
}

class GarbageProvider implements LLMProvider {
  calls = 0;
  constructor(private readonly body = '{"judgements": [{"songIndex": 0,' /* truncated */) {}
  async complete(): Promise<LlmCompleteResponse> {
    this.calls += 1;
    return { text: this.body, model: 'broken' };
  }
}

// ── Property helpers ──────────────────────────────────────────────────────────

function expectVerdictWellFormed(
  output: Awaited<ReturnType<typeof judgeRound>>,
  songs: readonly SongSpec[],
): void {
  const { results } = output;
  // Coverage: every song judged exactly once.
  expect(results).toHaveLength(songs.length);
  const seen = new Set<number>();
  for (const row of results) seen.add(row.songIndex);
  expect(seen.size).toBe(songs.length);
  expect([...seen].sort((a, b) => a - b)).toEqual(songs.map((_, i) => i));
  // Ranks are a permutation of 1..N.
  expect([...results].map((r) => r.rank).sort((a, b) => a - b)).toEqual(songs.map((_, i) => i + 1));
  // Scores clamped to 0..100 integers; rank order agrees with score order.
  for (const row of results) {
    expect(Number.isInteger(row.score)).toBe(true);
    expect(row.score).toBeGreaterThanOrEqual(0);
    expect(row.score).toBeLessThanOrEqual(100);
    expect(row.explanation.length).toBeGreaterThan(0);
  }
  const byRank = [...results].sort((a, b) => a.rank - b.rank);
  for (let i = 1; i < byRank.length; i += 1) {
    const prev = byRank[i - 1]!;
    const cur = byRank[i]!;
    expect(prev.score).toBeGreaterThanOrEqual(cur.score);
  }
}

// ── Properties over judgeRound ────────────────────────────────────────────────

describe('judgeRound properties (TDD §11)', () => {
  const rand = mulberry32(20260826);

  it('ranks are a permutation of 1..N and every song is covered exactly once', async () => {
    for (let round = 0; round < 40; round += 1) {
      const songs = randomSongs(rand);
      const scores = songs.map(() => Math.floor(rand() * 101));
      const llm = scriptedProvider([fullCoverage(songs, scores)]);
      const output = await judgeRound(
        { scenario: 'songs for a heist getaway', songs: numbered(songs) },
        llm,
        { backoffMs: 1, timeoutMs: 50 },
      );
      expect(output.model).toBe('test-model');
      expectVerdictWellFormed(output, songs);
      // Input order must not matter: shuffle → same invariant holds.
      const shuffled = shuffleWith(songs, rand);
      const reshuffledOutput = await judgeRound({ scenario: 'x', songs: numbered(shuffled) }, llm, {
        backoffMs: 1,
        timeoutMs: 50,
      });
      expectVerdictWellFormed(reshuffledOutput, shuffled);
    }
  });

  it('accepts boundary scores 0 and 100 and clamps everything into range', async () => {
    const songs: SongSpec[] = [
      { id: 'low', title: 'Silence', artist: 'Everyone' },
      { id: 'high', title: 'Bangers Only', artist: 'Louder' },
    ];
    const output = await judgeRound(
      { scenario: 'library quiet hours', songs: numbered(songs) },
      scriptedProvider([
        [
          { songIndex: 0, score: 0, explanation: 'silent' },
          { songIndex: 1, score: 100, explanation: 'loud' },
        ],
      ]),
    );
    expect(output.results.map((r) => r.score).sort((a, b) => a - b)).toEqual([0, 100]);

    // Fallback path obeys the same clamp property (run against the fallback too).
    for (let round = 0; round < 25; round += 1) {
      const batch = randomSongs(rand);
      const fallback = await judgeRound(
        { scenario: `s${round}`, songs: numbered(batch) },
        undefined,
      );
      expectVerdictWellFormed(fallback, batch);
    }
  });

  it('fallback judge is deterministic for identical inputs', async () => {
    const songs: SongSpec[] = Array.from({ length: 9 }, (_, i) => ({
      id: `track-${i}`,
      title: `Song ${i}`,
      artist: `Artist ${i % 3}`,
    }));
    const noLlmA = await judgeRound(
      { scenario: 'rainy commute', songs: numbered(songs) },
      undefined,
    );
    const noLlmB = await judgeRound(
      { scenario: 'rainy commute', songs: numbered(songs) },
      undefined,
    );
    expect(noLlmA).toEqual(noLlmB);
    expect(noLlmA.model).toBe(FALLBACK_MODEL);

    // A failing vendor degrades into the SAME deterministic verdict.
    const dead = new GarbageProvider('not json at all {{{');
    const degradedA = await judgeRound(
      { scenario: 'rainy commute', songs: numbered(songs) },
      dead,
      {
        attempts: 2,
        backoffMs: 1,
        timeoutMs: 50,
      },
    );
    const degradedB = await judgeRound(
      { scenario: 'rainy commute', songs: numbered(songs) },
      new GarbageProvider(),
      {
        attempts: 2,
        backoffMs: 1,
        timeoutMs: 50,
      },
    );
    expect(degradedA).toEqual(degradedB);
    expect(degradedA).toEqual(noLlmA);
  });

  it('malformed LLM JSON is retried, then the deterministic fallback lands', async () => {
    const songs: SongSpec[] = [
      { id: 'a', title: 'A', artist: 'AA' },
      { id: 'b', title: 'B', artist: 'BB' },
      { id: 'c', title: 'C', artist: 'CC' },
    ];
    const cases = [
      '{"judgements": [{"songIndex": 0,', // truncated JSON
      'I refuse to rank these songs.', // pure prose
      '<html><body>oops</body></html>', // wrong format entirely
      '', // empty
    ];
    for (const body of cases) {
      const llm = new GarbageProvider(body);
      const output = await judgeRound({ scenario: 's', songs: numbered(songs) }, llm, {
        attempts: 3,
        backoffMs: 1,
        timeoutMs: 50,
      });
      expect(llm.calls).toBe(3);
      expect(output.model).toBe(FALLBACK_MODEL);
      expect(output).toEqual(
        await judgeRound({ scenario: 's', songs: numbered(songs) }, undefined),
      );
      expectVerdictWellFormed(output, songs);
    }
  });

  it('tolerant parser accepts fenced and prose-wrapped verdicts', async () => {
    const songs: SongSpec[] = [
      { id: 'x', title: 'X', artist: 'XX' },
      { id: 'y', title: 'Y', artist: 'YY' },
    ];
    const inner = JSON.stringify({
      judgements: [
        { songIndex: 0, score: 42, explanation: 'mid' },
        { songIndex: 1, score: 96, explanation: 'banger' },
      ],
    });
    const wrap = (text: string): LLMProvider => ({
      async complete(): Promise<LlmCompleteResponse> {
        return { text, model: 'wrapped-model' };
      },
    });
    for (const text of [
      inner,
      '```json\n' + inner + '\n```',
      'Here you go:\n' + inner + '\nHope that helps!',
    ]) {
      const output = await judgeRound({ scenario: 's', songs: numbered(songs) }, wrap(text));
      expect(output.model).toBe('wrapped-model');
      expect(output.results.map((r) => r.rank).sort()).toEqual([1, 2]);
      expect(output.results.find((r) => r.songIndex === 1)?.score).toBe(96);
    }
  });
});

// ── Orchestrator wiring smoke (Phase 4 hand-off) ──────────────────────────────

function stubHub() {
  const frames: Array<{ code: string; frame: PushFrame }> = [];
  const hub: WsHub = {
    broadcastStateChange(code) {
      frames.push({ code, frame: { t: 'state_change', snapshot: {} as never } });
    },
    publish(code, frame) {
      frames.push({ code, frame });
    },
    toHosts(code, frame) {
      frames.push({ code, frame });
    },
    kick() {},
    closeRoom() {},
    connectionCount() {
      return 0;
    },
    setSnapshotBuilder() {},
  };
  return { hub, frames };
}

function fakeSubmissions(rows: StoredSubmission[]): SubmissionStoreView {
  return {
    count: (roundId) => rows.filter((r) => r.roundId === roundId).length,
    hasSubmitted: (roundId, playerId) =>
      rows.some((r) => r.roundId === roundId && r.playerId === playerId),
    list: (roundId) => rows.filter((r) => r.roundId === roundId),
  };
}

function sub(code: string, roundIdx: number, playerId: string, id: string): StoredSubmission {
  const track: Track = { id, title: `T ${id}`, artist: 'A', durationMs: 30_000 };
  return {
    roundId: roundIdOf(code, roundIdx),
    playerId,
    track,
    clientMsgId: `cmid-${playerId}-${id}`,
    createdAt: 0,
    chicken: false,
  };
}

const viewer = (playerId: string): WsViewer => ({
  playerId,
  role: 'host',
  nickname: `nick-${playerId}`,
});

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** LOBBY → … → PLAYBACK room with submissions, results store and an LLM seam. */
async function judgedRoom(llm: LLMProvider | undefined, aiJudgingMs = 400) {
  const roomManager = new RoomManager();
  const { hub, frames } = stubHub();
  const rows: StoredSubmission[] = [];
  const submissions = fakeSubmissions(rows);
  const resultsStore = new ResultsStore(submissions);
  const orch = new RoundOrchestrator({
    roomManager,
    wsHub: hub,
    ...(llm !== undefined ? { llm } : {}),
    submissions,
    results: resultsStore,
  });
  const host = roomManager.createRoom();
  const ada = roomManager.joinRoom(host.code, 'Ada');
  rows.push(sub(host.code, 0, ada.playerId, 't1'), sub(host.code, 0, ada.playerId, 't2'));
  const fsm = new RoomFsm({
    code: host.code,
    durations: { AI_JUDGING: aiJudgingMs },
    onChange: (change) => orch.onTransition(change),
  });
  orch.register(host.code, fsm);
  await fsm.dispatch('START_GAME');
  await fsm.dispatch('PICK_CATEGORY', { category: 'heist' });
  await fsm.dispatch('SKIP_PHASE'); // SCENARIO → SONG_SELECTION
  await fsm.dispatch('SKIP_PHASE'); // SONG_SELECTION → LOCKED
  await fsm.dispatch('BEGIN_PLAYBACK');
  await fsm.dispatch('QUEUE_DONE'); // PLAYBACK → AI_JUDGING (starts judgeRound)
  return { roomManager, orch, resultsStore, code: host.code, fsm, frames, ada };
}

describe('orchestrator × judgeRound wiring', () => {
  it('stores validated results, broadcasts the verdict frame, reaches RESULTS', async () => {
    const prompts: LlmCompleteRequest[] = [];
    const llm: LLMProvider = {
      async complete(req) {
        prompts.push(req);
        return {
          text: JSON.stringify({
            judgements: [
              { songIndex: 0, score: 88, explanation: 'getaway gold' },
              { songIndex: 1, score: 12, explanation: 'engine trouble' },
            ],
          }),
          model: 'vendor-x',
        };
      },
    };
    const { code, fsm, frames, resultsStore, ada, orch } = await judgedRoom(llm);
    await tick(60);
    expect(fsm.state).toBe('RESULTS');

    // ONE batched call carrying the checkpoint scenario + both songs.
    expect(prompts).toHaveLength(1);
    const userTurn = prompts[0]!.messages.find((m) => m.role === 'user')!.content;
    expect(userTurn).toContain('heist');
    expect(userTurn).toContain('"T t1"');
    expect(userTurn).toContain('"T t2"');

    // §6 rows persisted worst-first via core/results.ts + rank-point board.
    const stored = resultsStore.list(roundIdOf(code, 0));
    expect(stored.map((row) => row.rank)).toEqual([2, 1]);
    expect(stored.every((row) => row.judgeModel === 'vendor-x')).toBe(true);
    const board = resultsStore.leaderboard(code);
    expect(board).toEqual([{ playerId: ada.playerId, points: 8, wins: 1 }]);

    // Verdict frame went to the whole room with roster nicknames joined.
    const verdicts = frames.filter((f) => f.frame.t === 'judgement');
    expect(verdicts).toHaveLength(1);
    const payload = (verdicts[0]!.frame as Extract<PushFrame, { t: 'judgement' }>).payload;
    expect(payload?.results.map((r) => [r.rank, r.score, r.nickname])).toEqual([
      [1, 88, 'Ada'],
      [2, 12, 'Ada'],
    ]);
    expect(payload?.results.every((r) => r.title.startsWith('T '))).toBe(true);

    const snap = orch.buildSnapshot(code, viewer(ada.playerId));
    expect(snap?.state).toBe('RESULTS');
    expect(snap?.resultCount).toBe(2);
  });

  it('no LLM configured → deterministic fallback still lands in RESULTS', async () => {
    const { fsm, frames, resultsStore, ada } = await judgedRoom(undefined);
    await tick(60);
    expect(fsm.state).toBe('RESULTS');
    const stored = resultsStore.list(roundIdOf(fsm.code, 0));
    expect(stored).toHaveLength(2);
    expect(stored.every((row) => row.judgeModel === FALLBACK_MODEL)).toBe(true);
    const verdict = frames.find((f) => f.frame.t === 'judgement');
    expect(verdict).toBeDefined();
    const payload = (verdict!.frame as Extract<PushFrame, { t: 'judgement' }>).payload;
    expect(new Set(payload?.results.map((r) => r.rank))).toEqual(new Set([1, 2]));
    expect(ada.playerId).toBeTruthy();
  });

  it('LLM slower than the deadline → failsafe fallback advances the round', async () => {
    const stalled: LLMProvider = {
      complete: () => new Promise<LlmCompleteResponse>(() => {}),
    };
    const { fsm, frames, resultsStore } = await judgedRoom(stalled, 80);
    await tick(250);
    expect(fsm.state).toBe('RESULTS'); // 20 s failsafe logic at test scale
    const stored = resultsStore.list(roundIdOf(fsm.code, 0));
    expect(stored.every((row) => row.judgeModel === FALLBACK_MODEL)).toBe(true);
    expect(frames.filter((f) => f.frame.t === 'judgement')).toHaveLength(1);
  });

  it('throwing LLM adapter still reaches RESULTS via the fallback path', async () => {
    const bomb: LLMProvider = {
      complete: () => Promise.reject(new Error('socket exploded')),
    };
    // Retry backoff outlives the phase deadline → failsafe must win.
    const { fsm, resultsStore } = await judgedRoom(bomb, 100);
    await tick(300);
    expect(fsm.state).toBe('RESULTS');
    expect(resultsStore.count(roundIdOf(fsm.code, 0))).toBe(2);
  });
});
