import { describe, expect, it, vi } from 'vitest';
import { SnapshotSchema } from '@aux/shared';
import { RoomManager } from '../src/core/room-manager.js';
import { RoundOrchestrator, roundIdOf } from '../src/core/round-orchestrator.js';
import { ResultsStore } from '../src/core/results.js';
import type { StoredSubmission } from '../src/core/submissions.js';
import { RoomFsm } from '../src/fsm/engine.js';
import {
  LlmProviderError,
  type LLMProvider,
  type LlmCompleteRequest,
  type LlmCompleteResponse,
} from '../src/judge/llm-provider.js';

const response = (model = 'fixed-model'): LlmCompleteResponse => ({
  model,
  text: JSON.stringify({
    knowledge: 'known',
    totalScore: 7,
    categories: { scenarioFit: 2, mood: 2, lyrics: 1, genre: 1, wildcard: 1 },
    reasons: ['This scene suits the choice.', 'A fitting mood.'],
    defense: 'No defense filed.',
    verdict: 'A good fit.',
  }),
});
const asViewer = (playerId: string, role: 'player' | 'host' = 'player') => ({
  playerId,
  role,
  nickname: 'Test',
});
function deferredJudge() {
  const calls: Array<{
    req: LlmCompleteRequest;
    resolve: (r: LlmCompleteResponse) => void;
    reject: (e: unknown) => void;
  }> = [];
  const llm: LLMProvider = {
    modelName: 'fixed-model',
    complete: (req) => new Promise((resolve, reject) => calls.push({ req, resolve, reject })),
  };
  return { llm, calls };
}
async function room(
  options: {
    llm?: LLMProvider;
    practice?: boolean;
    voteDuration?: number;
    failure?: (code: string, reason: string) => void;
    players?: number;
  } = {},
) {
  const manager = new RoomManager();
  const host = manager.createRoom();
  const players = Array.from({ length: options.players ?? 3 }, (_, i) =>
    manager.joinRoom(host.code, `DJ ${i}`),
  );
  const rows: StoredSubmission[] = players.map((player, i) => ({
    roundId: roundIdOf(host.code, 0),
    playerId: player.playerId,
    track: { id: `track-${i}`, title: `Song ${i}`, artist: 'Artist', source: 'manual' },
    clientMsgId: `submission-${i}`,
    chicken: false,
    createdAt: i,
  }));
  const submissions = {
    list: () => rows,
    count: () => rows.length,
    hasSubmitted: (_r: string, id: string) => rows.some((row) => row.playerId === id),
  };
  const results = new ResultsStore(submissions);
  const orch = new RoundOrchestrator({
    roomManager: manager,
    submissions,
    results,
    ...(options.llm ? { llm: options.llm } : {}),
    ...(options.failure ? { onRoundFailure: options.failure } : {}),
    ...(options.voteDuration ? { crowdVoteDurationMs: options.voteDuration } : {}),
    canUseAi: () => options.practice !== true,
  });
  const fsm = new RoomFsm({ code: host.code, onChange: (change) => orch.onTransition(change) });
  orch.register(host.code, fsm);
  for (const event of [
    'START_GAME',
    'PICK_CATEGORY',
    'SKIP_PHASE',
    'SKIP_PHASE',
    'BEGIN_PLAYBACK',
    'QUEUE_DONE',
  ] as const)
    await fsm.dispatch(event, event === 'PICK_CATEGORY' ? { category: 'party' } : undefined);
  return {
    manager,
    host,
    players,
    rows,
    submissions,
    results,
    orch,
    fsm,
    snapshot: (i = 0) => orch.buildSnapshot(host.code, asViewer(players[i]!.playerId))!,
  };
}

describe('one consistent judgement for the whole round', () => {
  it('keeps every score private until all songs succeed and never rerolls on advance', async () => {
    const judge = deferredJudge();
    const game = await room({ llm: judge.llm });
    await vi.waitFor(() => expect(judge.calls).toHaveLength(3));
    expect(
      judge.calls.every(
        ({ req }) =>
          req.context?.roomCode === game.host.code &&
          req.context.roundIdx === 0 &&
          req.context.promptVersion === 'round-fit-v5',
      ),
    ).toBe(true);
    judge.calls[0]!.resolve(response());
    await vi.waitFor(() => expect(game.snapshot().judgingCompleted).toBe(1));
    expect(game.snapshot().judgingResult).toBeNull();
    expect(await game.orch.nextJudgement(game.host.code)).toBe('invalid');
    judge.calls[1]!.resolve(response());
    judge.calls[2]!.resolve(response());
    await vi.waitFor(() => expect(game.snapshot().judgingStatus).toBe('revealed'));
    expect(SnapshotSchema.parse(game.snapshot()).judgingResult?.judgeModel).toBe('fixed-model');
    await game.orch.nextJudgement(game.host.code);
    await game.orch.nextJudgement(game.host.code);
    await game.orch.nextJudgement(game.host.code);
    expect(game.fsm.state).toBe('RESULTS');
    expect(judge.calls).toHaveLength(3);
    game.orch.forget(game.host.code);
  });

  it('discards every AI score after one failure and reports the round failure once', async () => {
    const judge = deferredJudge();
    const failure = vi.fn();
    const game = await room({ llm: judge.llm, failure });
    await vi.waitFor(() => expect(judge.calls).toHaveLength(3));
    judge.calls[0]!.resolve(response());
    judge.calls[1]!.reject(new LlmProviderError('auth', 'Unavailable', false));
    await vi.waitFor(() => expect(game.snapshot().judgingMode).toBe('crowd'));
    expect(game.snapshot().judgingResult).toBeNull();
    expect(game.orch.serialize(game.host.code).judgingResults).toBeUndefined();
    expect(failure).toHaveBeenCalledExactlyOnceWith(game.host.code, 'auth');
    judge.calls[2]!.resolve(response());
    await Promise.resolve();
    expect(game.snapshot().judgingMode).toBe('crowd');
    expect(await game.orch.nextJudgement(game.host.code)).toBe('invalid');
    expect(failure).toHaveBeenCalledTimes(1);
    game.orch.forget(game.host.code);
  });

  it('does not mix model versions or let late jobs alter a forgotten room', async () => {
    const judge = deferredJudge();
    const failure = vi.fn();
    const game = await room({ llm: judge.llm, failure });
    await vi.waitFor(() => expect(judge.calls).toHaveLength(3));
    judge.calls[0]!.resolve(response('model-a'));
    judge.calls[1]!.resolve(response('model-b'));
    await vi.waitFor(() => expect(game.snapshot().judgingMode).toBe('crowd'));
    expect(failure).toHaveBeenCalledExactlyOnceWith(game.host.code, 'model_changed');
    game.orch.forget(game.host.code);
    judge.calls[2]!.resolve(response('model-a'));
    await Promise.resolve();
    expect(game.orch.serialize(game.host.code).judgingResults).toBeUndefined();
  });

  it('resumes an interrupted paid round as crowd voting without repeating paid requests', async () => {
    const judge = deferredJudge();
    const game = await room({ llm: judge.llm });
    await vi.waitFor(() => expect(judge.calls).toHaveLength(3));
    judge.calls[0]!.resolve(response());
    await vi.waitFor(() => expect(game.snapshot().judgingCompleted).toBe(1));
    const checkpoint = game.orch.serialize(game.host.code);
    game.orch.forget(game.host.code);
    const complete = vi.fn(async () => response());
    const failure = vi.fn();
    const restored = new RoundOrchestrator({
      roomManager: game.manager,
      submissions: game.submissions,
      llm: { complete },
      onRoundFailure: failure,
    });
    restored.hydrate(game.host.code, checkpoint);
    const fsm = new RoomFsm({
      code: game.host.code,
      initial: 'AI_JUDGING',
      onChange: (change) => restored.onTransition(change),
    });
    restored.register(game.host.code, fsm);
    restored.register(game.host.code, fsm);
    expect(
      restored.buildSnapshot(game.host.code, asViewer(game.players[0]!.playerId)),
    ).toMatchObject({ judgingMode: 'crowd', judgingResult: null });
    expect(complete).not.toHaveBeenCalled();
    expect(failure).toHaveBeenCalledExactlyOnceWith(game.host.code, 'interrupted');
    restored.forget(game.host.code);
  });

  it('practice never attempts a model or calls the outage refund hook', async () => {
    const complete = vi.fn(async () => response());
    const failure = vi.fn();
    const game = await room({ llm: { complete }, practice: true, failure });
    expect(game.snapshot().judgingMode).toBe('crowd');
    expect(complete).not.toHaveBeenCalled();
    expect(failure).not.toHaveBeenCalled();
    game.orch.forget(game.host.code);
  });
});

describe('server-owned anonymous crowd ballot', () => {
  it('rejects outsiders, stale ballots, self-votes and changes; identical replays are idempotent', async () => {
    const game = await room({ practice: true });
    const ballot = game.snapshot().crowdVote!;
    expect(ballot.options).toHaveLength(2);
    expect(ballot.options.every((o) => o.track.id !== game.rows[0]!.track.id)).toBe(true);
    expect(JSON.stringify(ballot)).not.toContain(game.players[1]!.playerId);
    expect(await game.orch.closeCrowdVote(game.host.code)).toBe('waiting');
    const option = ballot.options[0]!.id;
    expect(game.orch.castCrowdVote(game.host.code, 'stranger', ballot.ballotId, option)).toBe(
      'ineligible',
    );
    expect(
      game.orch.castCrowdVote(game.host.code, game.players[0]!.playerId, 'stale', option),
    ).toBe('invalid');
    const ownOption = game.orch
      .buildSnapshot(game.host.code, asViewer(game.host.playerId, 'host'))!
      .crowdVote!.options.find((o) => o.track.id === game.rows[0]!.track.id)!;
    expect(
      game.orch.castCrowdVote(
        game.host.code,
        game.players[0]!.playerId,
        ballot.ballotId,
        ownOption.id,
      ),
    ).toBe('invalid');
    expect(
      game.orch.castCrowdVote(game.host.code, game.players[0]!.playerId, ballot.ballotId, option),
    ).toBe('accepted');
    expect(
      game.orch.castCrowdVote(game.host.code, game.players[0]!.playerId, ballot.ballotId, option),
    ).toBe('duplicate');
    expect(
      game.orch.castCrowdVote(
        game.host.code,
        game.players[0]!.playerId,
        ballot.ballotId,
        ballot.options[1]!.id,
      ),
    ).toBe('invalid');
    expect(game.snapshot().crowdVote?.voted).toBe(true);
    const checkpoint = game.orch.serialize(game.host.code);
    game.orch.forget(game.host.code);
    const restored = new RoundOrchestrator({
      roomManager: game.manager,
      submissions: game.submissions,
    });
    restored.hydrate(game.host.code, checkpoint);
    const fsm = new RoomFsm({
      code: game.host.code,
      initial: 'AI_JUDGING',
      onChange: (c) => restored.onTransition(c),
    });
    restored.register(game.host.code, fsm);
    expect(
      restored.buildSnapshot(game.host.code, asViewer(game.players[0]!.playerId))?.crowdVote,
    ).toMatchObject({ ballotId: ballot.ballotId, voted: true, received: 1 });
    expect(
      restored.castCrowdVote(game.host.code, game.players[0]!.playerId, ballot.ballotId, option),
    ).toBe('duplicate');
    restored.forget(game.host.code);
  });

  it('shares tied places and points instead of silently deciding the winner', async () => {
    const game = await room({ practice: true });
    for (let i = 0; i < 3; i++) {
      const ballot = game.snapshot(i).crowdVote!;
      const target = game.rows[(i + 1) % 3]!.track.id;
      const option = ballot.options.find((o) => o.track.id === target)!;
      expect(
        game.orch.castCrowdVote(
          game.host.code,
          game.players[i]!.playerId,
          ballot.ballotId,
          option.id,
        ),
      ).toBe('accepted');
    }
    // Timer-driven; the 1 s default is too tight while the whole suite runs in parallel.
    await vi.waitFor(() => expect(game.fsm.state).toBe('RESULTS'), { timeout: 5_000 });
    const results = game.orch.serialize(game.host.code).results!;
    expect(results.map((r) => r.rank)).toEqual([1, 1, 1]);
    expect(results.every((r) => r.judgeModel === 'crowd-vote-v1' && r.score === 33)).toBe(true);
    expect(game.results.leaderboard(game.host.code).every((r) => r.points === 5)).toBe(true);
    expect(await game.orch.closeCrowdVote(game.host.code)).toBe('invalid');
    game.orch.forget(game.host.code);
  });

  it('closes unvoted and solo rounds without scores, points or a stalled game', async () => {
    const game = await room({ practice: true, voteDuration: 5 });
    // Timer-driven; the 1 s default is too tight while the whole suite runs in parallel.
    await vi.waitFor(() => expect(game.fsm.state).toBe('RESULTS'), { timeout: 5_000 });
    expect(
      game.orch
        .serialize(game.host.code)
        .results!.every((r) => r.judgeModel === 'crowd-no-votes' && r.score === 0),
    ).toBe(true);
    expect(
      game.results.leaderboard(game.host.code).every((r) => r.points === 0 && r.wins === 0),
    ).toBe(true);
    game.orch.forget(game.host.code);
    const solo = await room({ practice: true, players: 1 });
    await vi.waitFor(() => expect(solo.fsm.state).toBe('RESULTS'), { timeout: 5_000 });
    expect(solo.snapshot().leaderboard?.[0]).toMatchObject({ totalScore: 0, wins: 0 });
    solo.orch.forget(solo.host.code);
  });
});
