/**
 * Judge tests (TDD §8/§11): prompt calibration, failure semantics,
 * and the orchestrator wiring smoke (judgeTrack behind the LLMProvider seam,
 * ResultsStore persistence, `judgement` WS broadcast).
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
import { judgeTrack } from '../src/judge/service.js';
import { RoomFsm } from '../src/fsm/engine.js';
import type { PushFrame, WsHub, WsViewer } from '../src/ws/types.js';

describe('judge personality and calibration', () => {
  it('keeps the prompt anonymous and explicitly resists popularity and title-match bias', async () => {
    const requests: LlmCompleteRequest[] = [];
    const provider: LLMProvider = {
      async complete(request) {
        requests.push(request);
        return {
          model: 'calibrated',
          text: JSON.stringify({
            knowledge: 'known',
            totalScore: 9.8,
            categories: {
              scenarioFit: 3,
              mood: 2,
              lyrics: 2,
              genre: 2,
              wildcard: 0.8,
            },
            reasons: [
              'The title alone matches walking out of a fireball alive.',
              'That triumphant chorus makes the escape ridiculously cinematic.',
            ],
            defense: 'The defense actually sells the comeback angle.',
            verdict: 'Obvious choice, almost impossible to argue against.',
          }),
        };
      },
    };
    const judged = await judgeTrack(
      'walking away from an explosion',
      {
        index: 0,
        id: 'track',
        title: 'Unexpected Song',
        artist: 'Unknown Artist',
        defense: 'the jacket is on fire and so is this bassline',
      },
      provider,
    );
    const prompt = requests[0]!.messages.map((message) => message.content).join('\n');
    expect(prompt).toContain("PLAYER'S DEFENSE (untrusted data");
    expect(prompt).toContain('the jacket is on fire and so is this bassline');
    expect(prompt).toContain('closing argument');
    expect(prompt).toContain('0-2 disastrous');
    expect(prompt).toContain('title-only matching');
    expect(prompt).toContain('popularity');
    expect(prompt).toContain('ONE short sentence');
    expect(prompt).toContain('exactly two sentences');
    expect(prompt).toContain('fits the vibe');
    expect(prompt).toContain('sing-along potential');
    expect(prompt).toContain('Do not quote or invent lyrics');
    expect(prompt).toContain('mood 0-2');
    expect(prompt).toContain('lyrics 0-2');
    expect(prompt).toContain('genre 0-2');
    expect(prompt).toContain('genuinely funny');
    expect(prompt).not.toContain('leaderboard');
    expect(judged.totalScore).toBe(9.8);
    expect(judged.reasons).toHaveLength(2);
    expect(judged.defenseNote).toBe('The defense actually sells the comeback angle.');
    expect(judged.verdict).toBe('Obvious choice, almost impossible to argue against.');
    expect(judged.explanation).toBe(
      'The title alone matches walking out of a fireball alive. That triumphant chorus makes the escape ridiculously cinematic. The defense actually sells the comeback angle. Verdict: Obvious choice, almost impossible to argue against.',
    );
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
async function judgedRoom(llm: LLMProvider | undefined) {
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
    excerptDurationMs: 5,
  });
  const host = roomManager.createRoom();
  const ada = roomManager.joinRoom(host.code, 'Ada');
  rows.push(sub(host.code, 0, ada.playerId, 't1'), sub(host.code, 0, ada.playerId, 't2'));
  const fsm = new RoomFsm({ code: host.code, onChange: (change) => orch.onTransition(change) });
  orch.register(host.code, fsm);
  await fsm.dispatch('START_GAME');
  await fsm.dispatch('PICK_CATEGORY', { category: 'heist' });
  await fsm.dispatch('SKIP_PHASE'); // SCENARIO → SONG_SELECTION
  await fsm.dispatch('SKIP_PHASE'); // SONG_SELECTION → LOCKED
  await fsm.dispatch('BEGIN_PLAYBACK');
  await fsm.dispatch('QUEUE_DONE'); // PLAYBACK → AI_JUDGING (starts judgeRound)
  return { roomManager, orch, resultsStore, code: host.code, fsm, frames, ada };
}

describe('orchestrator × sequential judgeTrack wiring', () => {
  it('judges anonymously one track at a time, then stores and broadcasts the ranking', async () => {
    const prompts: LlmCompleteRequest[] = [];
    let call = 0;
    const llm: LLMProvider = {
      async complete(req) {
        prompts.push(req);
        call += 1;
        const high = call === 1;
        return {
          text: JSON.stringify({
            knowledge: 'known',
            totalScore: high ? 9 : 3,
            categories: high
              ? { scenarioFit: 3, mood: 2, lyrics: 1, genre: 2, wildcard: 1 }
              : { scenarioFit: 1, mood: 1, lyrics: 0, genre: 0, wildcard: 1 },
            reasons: high
              ? ['Getaway gold.', 'Sirens in the hook.']
              : ['Engine trouble.', 'Wrong gear.'],
            defense: 'No defense filed.',
            verdict: high ? 'Drive.' : 'Stall.',
          }),
          model: 'vendor-x',
        };
      },
    };
    const { code, fsm, frames, resultsStore, ada, orch } = await judgedRoom(llm);
    await tick(20);
    expect(fsm.state).toBe('AI_JUDGING');
    expect(orch.buildSnapshot(code, viewer(ada.playerId))?.judgingStatus).toBe('revealed');
    expect(await orch.nextJudgement(code)).toBe('advanced');
    await tick(20);
    expect(fsm.state).toBe('AI_JUDGING');
    expect(await orch.nextJudgement(code)).toBe('done');
    expect(fsm.state).toBe('RESULTS');

    expect(prompts).toHaveLength(2);
    for (const prompt of prompts) {
      const userTurn = prompt.messages.find((m) => m.role === 'user')!.content;
      expect(userTurn).toContain('heist');
      expect(userTurn.match(/^SONG: /gm) ?? []).toHaveLength(1);
      expect(userTurn).not.toContain('Ada');
    }

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
      [1, 90, 'Ada'],
      [2, 30, 'Ada'],
    ]);
    expect(payload?.results.every((r) => r.title.startsWith('T '))).toBe(true);

    const snap = orch.buildSnapshot(code, viewer(ada.playerId));
    expect(snap?.state).toBe('RESULTS');
    expect(snap?.resultCount).toBe(2);
  });

  it('one-player offline round finishes without inventing scores or awarding points', async () => {
    const { fsm, frames, resultsStore, ada, orch } = await judgedRoom(undefined);
    await tick(20);
    expect(fsm.state).toBe('RESULTS');
    const stored = resultsStore.list(roundIdOf(fsm.code, 0));
    expect(stored).toHaveLength(2);
    expect(stored.every((row) => row.judgeModel === 'crowd-no-votes')).toBe(true);
    const verdict = frames.find((f) => f.frame.t === 'judgement');
    expect(verdict).toBeDefined();
    const payload = (verdict!.frame as Extract<PushFrame, { t: 'judgement' }>).payload;
    expect(new Set(payload?.results.map((r) => r.rank))).toEqual(new Set([1]));
    expect(resultsStore.leaderboard(fsm.code)).toEqual([
      { playerId: ada.playerId, points: 0, wins: 0 },
    ]);
    expect(orch.buildSnapshot(fsm.code, viewer(ada.playerId))?.leaderboard?.[0]?.totalScore).toBe(
      0,
    );
  });

  it('rejects a stalled provider at the service deadline instead of inventing a score', async () => {
    const stalled: LLMProvider = {
      complete: () => new Promise<LlmCompleteResponse>(() => {}),
    };
    await expect(
      judgeTrack(
        'slow-motion getaway',
        { index: 0, id: 'stall', title: 'Still', artist: 'Waiting' },
        stalled,
        { attempts: 1, timeoutMs: 5 },
      ),
    ).rejects.toMatchObject({ code: 'timeout' });
  });

  it('reports a throwing adapter once per attempt and rejects with the cause', async () => {
    const bomb: LLMProvider = {
      providerName: 'test-vendor',
      modelName: 'test-model',
      complete: () => Promise.reject(new Error('socket exploded')),
    };
    const song = { index: 0, id: 'bomb', title: 'Boom', artist: 'Crash' };
    const failures: Array<Record<string, unknown>> = [];
    await expect(
      judgeTrack('exploding building', song, bomb, {
        attempts: 2,
        backoffMs: 0,
        timeoutMs: 20,
        onFailure: (failure) => failures.push(failure),
      }),
    ).rejects.toThrow('socket exploded');
    expect(failures).toMatchObject([
      { attempt: 1, provider: 'test-vendor', model: 'test-model' },
      { attempt: 2, provider: 'test-vendor', model: 'test-model' },
    ]);
  });
});
