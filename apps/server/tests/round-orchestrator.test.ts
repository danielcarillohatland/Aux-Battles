/**
 * RoundOrchestrator integration tests (AUX-006, Phase 3):
 *  - FSM-backed snapshot building (state/roundIdx/phaseEndsAt/submissions/you).
 *  - Approved catalog playback with project-owned and licensed tracks.
 *  - QUEUE_DONE → fallback-safe judge → RESULTS end-to-end.
 *  - Kick route: host-only, closes the socket via wsHub.kick + roster removal.
 */
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { Track } from '@aux/shared';
import { SnapshotSchema } from '@aux/shared';
import { Analytics, NullAnalyticsSink } from '../src/core/analytics.js';
import { RoomManager } from '../src/core/room-manager.js';
import { SqliteRoomStore } from '../src/core/room-store.js';
import {
  chooseExcerptWindow,
  RoundOrchestrator,
  roundIdOf,
  type SubmissionStoreView,
} from '../src/core/round-orchestrator.js';
import { SubmissionStore, type StoredSubmission } from '../src/core/submissions.js';
import { RoomFsm } from '../src/fsm/engine.js';
import type { ApprovedMusicCatalog } from '../src/providers/music-provider.js';
import type { LLMProvider } from '../src/judge/llm-provider.js';
import { gameRuntimesRoute } from '../src/routes/game-runtimes.js';
import type { PushFrame, WsHub, WsViewer } from '../src/ws/types.js';

// ── Test doubles ──────────────────────────────────────────────────────────────

function fakeSubmissions(rows: StoredSubmission[]): SubmissionStoreView {
  return {
    count(roundId) {
      return rows.filter((r) => r.roundId === roundId).length;
    },
    hasSubmitted(roundId, playerId) {
      return rows.some((r) => r.roundId === roundId && r.playerId === playerId);
    },
    list(roundId) {
      return rows.filter((r) => r.roundId === roundId);
    },
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

function stubHub() {
  const frames: Array<{ code: string; frame: PushFrame }> = [];
  const kicked: Array<{ code: string; playerId: string; reason: string }> = [];
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
    kick(code, playerId, reason) {
      kicked.push({ code, playerId, reason });
    },
    closeRoom() {},
    connectionCount() {
      return 0;
    },
    setSnapshotBuilder() {},
  };
  return { hub, frames, kicked };
}

const testCatalog: ApprovedMusicCatalog = {
  search: async () => [],
  getTrack: async (id) => ({ id, title: `T ${id}`, artist: 'A', source: 'original' }),
  listTracks: () => [],
  playableTrack: ({ id }) => ({ id, title: `T ${id}`, artist: 'A', source: 'original' }),
};

function viewer(playerId: string, role: 'host' | 'player'): WsViewer {
  return { playerId, role, nickname: `nick-${playerId.slice(0, 4)}` };
}

/** Build a LOCKED room with orchestrator + fsm wired like game-runtimes does. */
function lockedRoom(opts: {
  catalog?: ApprovedMusicCatalog;
  /** Row factory — receives the REAL generated room code. */
  rows?: (code: string) => StoredSubmission[];
  submissions?: SubmissionStoreView;
  excerptDurationMs?: number;
  llm?: LLMProvider;
}) {
  const roomManager = new RoomManager();
  const { hub, frames } = stubHub();
  const orch = new RoundOrchestrator({
    roomManager,
    wsHub: hub,
    ...(opts.submissions !== undefined ? { submissions: opts.submissions } : {}),
    ...(opts.excerptDurationMs !== undefined ? { excerptDurationMs: opts.excerptDurationMs } : {}),
    ...(opts.llm !== undefined ? { llm: opts.llm } : {}),
  });
  orch.setCatalogPlayback(opts.catalog ?? testCatalog);
  const { code } = roomManager.createRoom();
  if (opts.rows !== undefined) {
    orch.setSubmissions(fakeSubmissions(opts.rows(code)));
  }
  // Short AI_JUDGING so the fallback deadline completes inside the test.
  const fsm = new RoomFsm({
    code,
    durations: { AI_JUDGING: 40 },
    onChange: (c) => orch.onTransition(c),
  });
  orch.register(code, fsm);
  return { roomManager, hub, frames, orch, code, fsm };
}

/** Drive LOBBY → LOCKED through the mutex, awaiting each hop. */
async function driveToLocked(fsm: RoomFsm): Promise<void> {
  await fsm.dispatch('START_GAME');
  await fsm.dispatch('PICK_CATEGORY', { category: 'party' });
  await fsm.dispatch('SKIP_PHASE'); // SCENARIO → SONG_SELECTION
  await fsm.dispatch('SKIP_PHASE'); // SONG_SELECTION → LOCKED
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('excerpt window selection', () => {
  it('chooses a deterministic middle section with a safe ending guard', () => {
    expect(chooseExcerptWindow(180_000)).toEqual({
      excerptStartMs: 68_400,
      excerptDurationMs: 30_000,
    });
    expect(chooseExcerptWindow(30_000)).toEqual({
      excerptStartMs: 0,
      excerptDurationMs: 30_000,
    });
  });

  it('handles tracks shorter than the requested excerpt safely', () => {
    expect(chooseExcerptWindow(9_000)).toEqual({
      excerptStartMs: 0,
      excerptDurationMs: 9_000,
    });
  });
});

// ── Snapshots ────────────────────────────────────────────────────────────────

describe('RoundOrchestrator snapshots (AUX-006)', () => {
  it('falls back to LOBBY-shaped truth when no runtime exists', () => {
    const roomManager = new RoomManager();
    const { hub } = stubHub();
    const orch = new RoundOrchestrator({ roomManager, wsHub: hub });
    const { code } = roomManager.createRoom();
    const snap = orch.buildSnapshot(code, viewer('p1', 'host'));
    expect(snap).toMatchObject({
      state: 'LOBBY',
      roundIdx: 0,
      phaseEndsAt: null,
      playbackMode: 'catalog',
      submissionsCount: 0,
      you: { role: 'host', hasSubmitted: false },
    });
    expect(orch.buildSnapshot('ZZZZZ', viewer('p1', 'host'))).toBeNull();
  });

  it('carries live FSM state and real submission counts per viewer', async () => {
    const { orch, code, fsm } = lockedRoom({
      rows: (c) => [sub(c, 0, 'p-host', 't1'), sub(c, 0, 'p-guest', 't2')],
    });
    await driveToLocked(fsm);
    await fsm.dispatch('BEGIN_PLAYBACK');
    const host = orch.buildSnapshot(code, viewer('p-host', 'host'));
    const guest = orch.buildSnapshot(code, viewer('p-guest', 'player'));
    expect(host?.state).toBe('PLAYBACK');
    expect(host?.submissionsCount).toBe(2);
    // A custom pick is the prompt itself (D-029); presets draw from a vibe.
    expect(host?.scenario).toBe('party');
    expect(host?.category).toBe('Custom');
    // Custom prompts are not catalogue scenes, so they leave recent history untouched.
    expect(orch.serialize(code).recentScenarioIds ?? []).toHaveLength(0);
    expect(host?.you.hasSubmitted).toBe(true);
    expect(guest?.you.role).toBe('player');
    expect(guest?.you.hasSubmitted).toBe(true);
  });
});

// ── Approved in-app playback ─────────────────────────────────────────────────

describe('playback mode selection (D-E)', () => {
  it('uses host-browser catalog playback and advances one shuffled card at a time', async () => {
    const { orch, code, fsm, frames } = lockedRoom({
      rows: (c) => [sub(c, 0, 'a', 't1'), sub(c, 0, 'b', 't2'), sub(c, 0, 'c', 't3')],
      excerptDurationMs: 50,
    });
    await driveToLocked(fsm);
    await fsm.dispatch('BEGIN_PLAYBACK');
    await tick(20);

    expect(orch.buildSnapshot(code, viewer('x', 'host'))).toMatchObject({
      playbackMode: 'catalog',
      playbackDevice: 'Host browser',
      playbackStatus: 'ready',
    });

    expect(await orch.manualNext(code)).toBe('advanced');
    expect(orch.buildSnapshot(code, viewer('x', 'host'))?.playbackIndex).toBe(1);
    expect(frames.length).toBeGreaterThanOrEqual(2); // transition + mode broadcast
  });

  it('rejects a duplicate Next while the first advance is in flight', async () => {
    const { orch, code, fsm } = lockedRoom({
      rows: (c) => [sub(c, 0, 'a', 't1'), sub(c, 0, 'b', 't2')],
      excerptDurationMs: 100,
    });
    await driveToLocked(fsm);
    await fsm.dispatch('BEGIN_PLAYBACK');
    await tick(10);

    const first = orch.manualNext(code);
    const duplicate = orch.manualNext(code);
    await expect(duplicate).resolves.toBe('invalid');
    await expect(first).resolves.toBe('advanced');
  });

  it('falls back safely when an old or tampered id is outside the approved catalog', async () => {
    const denyingCatalog: ApprovedMusicCatalog = {
      ...testCatalog,
      playableTrack: () => null,
    };
    const { orch, code, fsm } = lockedRoom({
      catalog: denyingCatalog,
      rows: (c) => [sub(c, 0, 'a', 't1')],
    });
    await driveToLocked(fsm);
    await fsm.dispatch('BEGIN_PLAYBACK');
    await tick(20);
    expect(orch.buildSnapshot(code, viewer('x', 'host'))?.playbackMode).toBe('manual');
    expect(orch.buildSnapshot(code, viewer('x', 'host'))?.playbackError).toContain(
      'approved catalog',
    );
  });

  it('supports a mixed original/licensed queue through one catalog mode', async () => {
    const mixedCatalog: ApprovedMusicCatalog = {
      ...testCatalog,
      playableTrack({ id }, roomCode) {
        return id.startsWith('licensed:')
          ? {
              id,
              title: `Licensed ${id}`,
              artist: 'Cleared Artist',
              durationMs: 90_000,
              source: 'licensed',
              playbackUrl: `/api/v1/rooms/${roomCode}/licensed-music/${encodeURIComponent(id)}/audio`,
            }
          : { id, title: 'Midnight Pancakes', artist: 'AUX House Band', source: 'original' };
      },
    };
    const { orch, code, fsm } = lockedRoom({
      catalog: mixedCatalog,
      rows: (c) => [sub(c, 0, 'a', 'original:one'), sub(c, 0, 'b', 'licensed:two')],
    });

    await driveToLocked(fsm);
    await fsm.dispatch('BEGIN_PLAYBACK');
    await tick(20);

    const snapshot = orch.buildSnapshot(code, viewer('x', 'host'));
    expect(snapshot?.playbackMode).toBe('catalog');
    expect(snapshot?.playbackStatus).toBe('ready');
    expect(snapshot?.playbackDevice).toBe('Host browser');
    expect(snapshot?.queue?.some((track) => track.source === 'original')).toBe(true);
    expect(snapshot?.queue?.find((track) => track.source === 'licensed')?.playbackUrl).toMatch(
      /^\/api\/v1\//,
    );
  });
});

// ── Queue done → judge → RESULTS ─────────────────────────────────────────────

describe('QUEUE_DONE → sequential AI_JUDGING → JUDGEMENT_STORED', () => {
  it('judges and reveals each song before final ranking', async () => {
    const { orch, code, fsm } = lockedRoom({
      rows: (c) => [sub(c, 0, 'a', 't1'), sub(c, 0, 'b', 't2')],
      excerptDurationMs: 5,
      llm: {
        complete: async () => ({
          model: 'round-model',
          text: JSON.stringify({
            knowledge: 'known',
            totalScore: 7,
            categories: { scenarioFit: 2, mood: 2, lyrics: 1, genre: 1, wildcard: 1 },
            reasons: ['The scene fits.', 'The mood fits.'],
            defense: 'No defense filed.',
            verdict: 'A solid pick.',
          }),
        }),
      },
    });
    await driveToLocked(fsm);
    await fsm.dispatch('BEGIN_PLAYBACK');
    await tick(20);
    // Judging runs in the background during Listening (D-027): both verdicts
    // are checkpointed before the host ever reaches the Judge stage.
    const listening = orch.serialize(code) as { judgingResults?: Array<{ index: number }> };
    expect(listening.judgingResults?.map((row) => row.index).sort()).toEqual([0, 1]);
    await fsm.dispatch('QUEUE_DONE');
    await tick(20);
    expect(fsm.state).toBe('AI_JUDGING');
    let snapshot = orch.buildSnapshot(code, viewer('a', 'host'));
    expect(snapshot?.judgingStatus).toBe('revealed');
    expect(snapshot?.judgingIndex).toBe(0);
    expect(snapshot?.judgingResult?.categories.scenarioFit).toBeGreaterThanOrEqual(0);
    // Provenance survives schema parsing so clients can disclose degraded scoring.
    expect(SnapshotSchema.parse(snapshot).judgingResult?.judgeModel).toBe('round-model');
    // Every track is judged up front (D-027); only index 0 is revealed so far.
    const checkpoint = orch.serialize(code) as {
      judgingIndex?: number;
      judgingStatus?: string;
      judgingResults?: Array<{ index: number }>;
    };
    expect(checkpoint).toMatchObject({ judgingIndex: 0, judgingStatus: 'revealed' });
    expect(checkpoint.judgingResults?.map((row) => row.index).sort()).toEqual([0, 1]);

    expect(await orch.nextJudgement(code)).toBe('advanced');
    expect(fsm.state).toBe('AI_JUDGING');
    await tick(20);
    snapshot = orch.buildSnapshot(code, viewer('a', 'host'));
    expect(snapshot?.judgingIndex).toBe(1);
    expect(snapshot?.judgingStatus).toBe('revealed');

    expect(await orch.nextJudgement(code)).toBe('done');
    expect(fsm.state).toBe('RESULTS');

    const hostSnap = orch.buildSnapshot(code, viewer('a', 'host'));
    expect(hostSnap?.you.hasSubmitted).toBe(true);
  });

  it('adds Midnight Pancakes and its sonic profile to judge review', async () => {
    const prompts: string[] = [];
    const llm: LLMProvider = {
      async complete(request) {
        prompts.push(request.messages.map((message) => message.content).join('\n'));
        return {
          model: 'profile-aware-judge',
          text: JSON.stringify({
            knowledge: 'known',
            totalScore: 8,
            categories: {
              scenarioFit: 3,
              mood: 2,
              lyrics: 1.5,
              genre: 0.75,
              wildcard: 0.75,
            },
            reasons: [
              'The playful funk profile gives this strange moment exactly the right bounce.',
              'A rubbery bassline is the correct response to pancakes at midnight.',
            ],
            defense: 'No defense filed.',
            verdict: 'Breakfast after dark, served correctly.',
          }),
        };
      },
    };
    const midnight: Track = {
      id: 'original:midnight-pancakes',
      title: 'Midnight Pancakes',
      artist: 'AUX House Band',
      source: 'original',
      description: 'Playful funk-pop with a rubbery bassline and late-night mischief.',
    };
    const catalog: ApprovedMusicCatalog = {
      ...testCatalog,
      getTrack: async () => midnight,
      playableTrack: () => midnight,
    };
    const { orch, code, fsm } = lockedRoom({
      catalog,
      rows: (c) => [{ ...sub(c, 0, 'a', midnight.id), track: midnight }],
      excerptDurationMs: 5,
      llm,
    });
    await driveToLocked(fsm);
    await fsm.dispatch('BEGIN_PLAYBACK');
    await tick(20);
    await fsm.dispatch('QUEUE_DONE');
    await tick(20);
    const snapshot = orch.buildSnapshot(code, viewer('x', 'host'));
    expect(fsm.state).toBe('AI_JUDGING');
    expect(snapshot?.judgingStatus).toBe('revealed');
    expect(snapshot?.judgingTrack?.title).toBe('Midnight Pancakes');
    expect(prompts.join('\n')).toContain('Playful funk-pop');
  });

  it('shares the place for equal rubric totals instead of a hidden track-id tiebreak', async () => {
    const llm: LLMProvider = {
      async complete() {
        return {
          model: 'tie-model',
          text: JSON.stringify({
            knowledge: 'known',
            totalScore: 5,
            categories: {
              scenarioFit: 2,
              mood: 1,
              lyrics: 1,
              genre: 0.5,
              wildcard: 0.5,
            },
            reasons: ['Equal fit under the same rubric.', 'Same sound, same scene.'],
            defense: 'No defense filed.',
            verdict: 'A tie.',
          }),
        };
      },
    };
    const { orch, code, fsm } = lockedRoom({
      rows: (c) => [sub(c, 0, 'a', 'z-track'), sub(c, 0, 'b', 'a-track')],
      excerptDurationMs: 1,
      llm,
    });
    await driveToLocked(fsm);
    await fsm.dispatch('BEGIN_PLAYBACK');
    await tick(10);
    await fsm.dispatch('QUEUE_DONE');
    await tick(15);
    await orch.nextJudgement(code);
    await tick(15);
    await orch.nextJudgement(code);

    const ranked = orch.serialize(code).results ?? [];
    expect(ranked).toHaveLength(2);
    expect(ranked.map((entry) => entry.rank)).toEqual([1, 1]);
    const points = orch.buildSnapshot(code, {
      playerId: 'a',
      role: 'host',
      nickname: null,
    })?.leaderboard;
    expect(new Set(points?.map((entry) => entry.totalScore))).toEqual(new Set([5]));
  });

  it('breaks equal totals by scenario fit, the documented heaviest rubric line', async () => {
    let call = 0;
    const llm: LLMProvider = {
      async complete() {
        call += 1;
        const fitHeavy = call === 1;
        return {
          model: 'tie-model',
          text: JSON.stringify({
            knowledge: 'known',
            categories: fitHeavy
              ? { scenarioFit: 3, mood: 1, lyrics: 0.5, genre: 0.5, wildcard: 0 }
              : { scenarioFit: 1, mood: 2, lyrics: 1, genre: 1, wildcard: 0 },
            reasons: ['Equal total under the same rubric.', 'Different strengths.'],
            defense: 'No defense filed.',
            verdict: 'Close.',
          }),
        };
      },
    };
    const { orch, code, fsm } = lockedRoom({
      rows: (c) => [sub(c, 0, 'a', 'one'), sub(c, 0, 'b', 'two')],
      excerptDurationMs: 1,
      llm,
    });
    await driveToLocked(fsm);
    await fsm.dispatch('BEGIN_PLAYBACK');
    await tick(10);
    await fsm.dispatch('QUEUE_DONE');
    await tick(15);
    await orch.nextJudgement(code);
    await tick(15);
    await orch.nextJudgement(code);

    const ranked = orch.serialize(code).results ?? [];
    expect(ranked.map((entry) => [entry.rank, entry.categories?.scenarioFit])).toEqual(
      expect.arrayContaining([
        [1, 3],
        [2, 1],
      ]),
    );
  });
});

// ── Kick route ───────────────────────────────────────────────────────────────

describe('POST /rooms/:code/kick', () => {
  async function kickApp() {
    const app = Fastify({ logger: false });
    const roomManager = new RoomManager();
    const { hub, kicked, frames } = stubHub();
    await app.register(
      gameRuntimesRoute({
        roomManager,
        store: new SqliteRoomStore(':memory:'),
        analytics: new Analytics(new NullAnalyticsSink()),
        wsHub: hub,
        submissions: new SubmissionStore(),
      }),
      { prefix: '/api/v1' },
    );
    const created = roomManager.createRoom();
    const joined = roomManager.joinRoom(created.code, 'Guest');
    return { app, roomManager, ...created, joined, kicked, frames };
  }

  it('removes the player from the roster and pushes kicked', async () => {
    const ctx = await kickApp();
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/rooms/${ctx.code}/kick`,
      headers: { authorization: `Bearer ${ctx.hostToken}` },
      payload: { playerId: ctx.joined.playerId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, data: { kicked: true } });
    expect(ctx.roomManager.get(ctx.code)?.players.has(ctx.joined.playerId)).toBe(false);
    expect(ctx.kicked).toEqual([
      { code: ctx.code, playerId: ctx.joined.playerId, reason: 'kicked by host' },
    ]);
    expect(ctx.frames.some((f) => f.frame.t === 'state_change')).toBe(true);
    await ctx.app.close();
  });

  it('rejects non-hosts, unknown players, and kicking the host', async () => {
    const ctx = await kickApp();
    const base = { url: `/api/v1/rooms/${ctx.code}/kick` };

    const notHost = await ctx.app.inject({
      ...base,
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.joined.playerToken}` },
      payload: { playerId: ctx.playerId },
    });
    expect(notHost.statusCode).toBe(403);

    const unknownPlayer = await ctx.app.inject({
      ...base,
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.hostToken}` },
      payload: { playerId: 'no-such-player' },
    });
    expect(unknownPlayer.statusCode).toBe(404);

    const kickHost = await ctx.app.inject({
      ...base,
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.hostToken}` },
      payload: { playerId: ctx.playerId },
    });
    expect(kickHost.statusCode).toBe(409);
    expect(ctx.kicked).toEqual([]);
    await ctx.app.close();
  });
});
