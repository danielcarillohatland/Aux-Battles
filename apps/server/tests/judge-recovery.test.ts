import { describe, expect, it, vi } from 'vitest';
import { RoomManager } from '../src/core/room-manager.js';
import { RoundOrchestrator } from '../src/core/round-orchestrator.js';
import type { StoredSubmission } from '../src/core/submissions.js';
import { RoomFsm } from '../src/fsm/engine.js';
import type { JudgedEntry } from '../src/judge/judge-service.js';
import type { LLMProvider, LlmCompleteResponse } from '../src/judge/llm-provider.js';

const categories = { scenarioFit: 2, mood: 2, lyrics: 1, genre: 1, wildcard: 1 };
const response: LlmCompleteResponse = {
  model: 'test-model',
  text: JSON.stringify({
    knowledge: 'known',
    totalScore: 7,
    categories,
    reasons: ['A fitting choice.', 'The theme matches the scene.'],
    defense: 'No defense filed.',
    verdict: 'A strong pick.',
  }),
};

function fixture(llm: LLMProvider) {
  const roomManager = new RoomManager();
  const { code, playerId } = roomManager.createRoom();
  const submission = (roundIdx: number): StoredSubmission => ({
    roundId: `${code}:${roundIdx}`,
    playerId,
    track: { id: `manual:round-${roundIdx}:artist`, title: `Round ${roundIdx}`, artist: 'Artist' },
    chicken: false,
    clientMsgId: `submission-${roundIdx}`,
    createdAt: 0,
  });
  const rows = [submission(0), submission(1)];
  const orch = new RoundOrchestrator({
    roomManager,
    llm,
    submissions: {
      list: (roundId) => rows.filter((row) => row.roundId === roundId),
      count: (roundId) => rows.filter((row) => row.roundId === roundId).length,
      hasSubmitted: () => true,
    },
  });
  const fsm = new RoomFsm({ code, initial: 'AI_JUDGING', onChange: (c) => orch.onTransition(c) });
  const snapshot = () => orch.buildSnapshot(code, { playerId, role: 'host', nickname: 'Host' });
  return { code, playerId, rows, orch, fsm, snapshot };
}

describe('judgement crash recovery', () => {
  it('finishes a checkpointed result transition without judging or awarding points twice', async () => {
    const complete = vi.fn(async () => response);
    const { code, playerId, rows, orch, fsm, snapshot } = fixture({ complete });
    const entry: JudgedEntry = {
      playerId,
      track: rows[0]!.track,
      chicken: false,
      rank: 1,
      score: 70,
      totalScore: 7,
      categories,
      explanation: 'A result already awarded before the crash.',
      judgeModel: 'test-model',
    };
    // storeJudgement writes this checkpoint before JUDGEMENT_STORED dispatches.
    orch.hydrate(code, {
      version: 1,
      queue: [rows[0]!],
      results: [entry],
      judgingIndex: 0,
      judgingStatus: 'revealed',
      judgingResults: [{ index: 0, entry }],
      leaderboard: [{ playerId, nickname: 'Host', totalScore: 5, wins: 1 }],
    });
    orch.register(code, fsm);
    await vi.waitFor(() => expect(fsm.state).toBe('RESULTS'));
    expect(complete).not.toHaveBeenCalled();
    expect(snapshot()?.resultCount).toBe(1);
    expect(orch.serialize(code)?.leaderboard).toEqual([
      { playerId, nickname: 'Host', totalScore: 5, wins: 1 },
    ]);
    expect(await orch.nextJudgement(code)).toBe('invalid');
  });

  it('also completes a checkpointed empty round', async () => {
    const complete = vi.fn(async () => response);
    const { code, orch, fsm } = fixture({ complete });
    orch.hydrate(code, { version: 1, results: [], queue: [] });
    orch.register(code, fsm);
    await vi.waitFor(() => expect(fsm.state).toBe('RESULTS'));
    expect(complete).not.toHaveBeenCalled();
  });

  it('resumes an interrupted current judgement when no final result was stored', async () => {
    const complete = vi.fn(async () => response);
    const { code, rows, orch, fsm, snapshot } = fixture({ complete });
    orch.hydrate(code, {
      version: 1,
      queue: [rows[0]!],
      judgingIndex: 0,
      judgingStatus: 'analyzing',
    });
    orch.register(code, fsm);
    await vi.waitFor(() => expect(snapshot()?.judgingStatus).toBe('revealed'));
    expect(snapshot()?.judgingResult?.judgeModel).toBe('test-model');
    expect(complete).toHaveBeenCalledTimes(1);
    expect(await orch.nextJudgement(code)).toBe('done');
    expect(fsm.state).toBe('RESULTS');
  });

  it('does not let a pending older round reveal the same index in a newer round', async () => {
    const finish: Array<(value: LlmCompleteResponse) => void> = [];
    const complete = vi.fn(
      () => new Promise<LlmCompleteResponse>((resolve) => finish.push(resolve)),
    );
    const { code, orch, fsm, snapshot } = fixture({ complete });
    orch.register(code, fsm);
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));

    // Simulate the old round being completed while its asynchronous work remains.
    await fsm.dispatch('JUDGEMENT_STORED');
    await fsm.dispatch('ADVANCE_REVEAL', { final: true });
    await fsm.dispatch('NEXT_ROUND');
    await fsm.dispatch('PICK_CATEGORY', { category: 'A new scene' });
    await fsm.dispatch('SKIP_PHASE');
    await fsm.dispatch('SKIP_PHASE');
    await fsm.dispatch('BEGIN_PLAYBACK');
    await fsm.dispatch('QUEUE_DONE');
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2));
    expect(snapshot()?.roundIdx).toBe(1);
    expect(snapshot()?.judgingStatus).toBe('analyzing');

    finish[0]!(response);
    // Drain the completion chain, including both the cached job and reveal waiter.
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    expect(snapshot()?.judgingStatus).toBe('analyzing');
    expect(snapshot()?.judgingResult).toBeNull();

    finish[1]!(response);
    await vi.waitFor(() => expect(snapshot()?.judgingStatus).toBe('revealed'));
    expect(snapshot()?.judgingTrack?.title).toBe('Round 1');
  });
});
