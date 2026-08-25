/**
 * RoundOrchestrator integration tests (AUX-006, Phase 3):
 *  - FSM-backed snapshot building (state/roundIdx/phaseEndsAt/submissions/you).
 *  - L0/L4 playback-mode selection per D-E: api ONLY with a live session AND a
 *    device; ONE startPlayback with the full shuffled queue; manual otherwise.
 *  - QUEUE_DONE detection in api mode → AI_JUDGING → placeholder judge fires
 *    JUDGEMENT_STORED so RESULTS is reached end-to-end.
 *  - Kick route: host-only, closes the socket via wsHub.kick + roster removal.
 */
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { Track } from '@aux/shared';
import { Analytics, NullAnalyticsSink } from '../src/core/analytics.js';
import { RoomManager } from '../src/core/room-manager.js';
import { SqliteRoomStore } from '../src/core/room-store.js';
import {
  RoundOrchestrator,
  roundIdOf,
  type LiveSessionProbe,
  type SubmissionStoreView,
} from '../src/core/round-orchestrator.js';
import { SubmissionStore, type StoredSubmission } from '../src/core/submissions.js';
import { RoomFsm } from '../src/fsm/engine.js';
import type { MusicProvider, StartPlaybackRequest } from '../src/providers/music-provider.js';
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

const liveProbe: LiveSessionProbe = { getAccessToken: () => Promise.resolve('tok') };
const deadProbe: LiveSessionProbe = { getAccessToken: () => Promise.resolve(null) };

class StubProvider implements MusicProvider {
  started: StartPlaybackRequest[] = [];
  device: { id: string; name: string } | null = { id: 'dev1', name: 'Speaker' };
  state: {
    isPlaying: boolean;
    progressMs: number | null;
    trackId: string | null;
    deviceId: string | null;
  } | null = null;

  search() {
    return Promise.reject(new Error('unused'));
  }
  getTrack() {
    return Promise.reject(new Error('unused'));
  }
  authenticateHost() {
    return Promise.resolve({ ok: true, deviceRequired: true });
  }
  async startPlayback(req: StartPlaybackRequest) {
    this.started.push(req);
    this.state = { isPlaying: true, progressMs: 0, trackId: null, deviceId: req.deviceId ?? null };
  }
  async pause() {}
  async resume() {}
  async next() {}
  getActiveDevice() {
    return Promise.resolve(this.device);
  }
  getPlaybackState() {
    return Promise.resolve(this.state);
  }
}

function viewer(playerId: string, role: 'host' | 'player'): WsViewer {
  return { playerId, role, nickname: `nick-${playerId.slice(0, 4)}` };
}

/** Build a LOCKED room with orchestrator + fsm wired like game-runtimes does. */
function lockedRoom(opts: {
  provider?: StubProvider;
  probe?: LiveSessionProbe;
  /** Row factory — receives the REAL generated room code. */
  rows?: (code: string) => StoredSubmission[];
  pollMs?: number;
  submissions?: SubmissionStoreView;
}) {
  const roomManager = new RoomManager();
  const { hub, frames } = stubHub();
  const orch = new RoundOrchestrator({
    roomManager,
    wsHub: hub,
    ...(opts.pollMs !== undefined ? { pollMs: opts.pollMs } : {}),
    ...(opts.submissions !== undefined ? { submissions: opts.submissions } : {}),
  });
  if (opts.provider !== undefined && opts.probe !== undefined) {
    orch.setPlayback(opts.provider, opts.probe);
  }
  const { code } = roomManager.createRoom();
  if (opts.rows !== undefined) {
    orch.setSubmissions(fakeSubmissions(opts.rows(code)));
  }
  // Short AI_JUDGING so the placeholder judge path completes inside the test.
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
      playbackMode: 'manual',
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
    expect(host?.you.hasSubmitted).toBe(true);
    expect(guest?.you.role).toBe('player');
    expect(guest?.you.hasSubmitted).toBe(true);
  });
});

// ── Playback selection (L0/L4) ───────────────────────────────────────────────

describe('playback mode selection (D-E)', () => {
  it('api mode: ONE startPlayback with the full shuffled queue when live + device', async () => {
    const provider = new StubProvider();
    const { orch, code, fsm, frames } = lockedRoom({
      provider,
      probe: liveProbe,
      rows: (c) => [sub(c, 0, 'a', 't1'), sub(c, 0, 'b', 't2'), sub(c, 0, 'c', 't3')],
    });
    await driveToLocked(fsm);
    await fsm.dispatch('BEGIN_PLAYBACK');
    await tick(20);

    expect(provider.started).toHaveLength(1); // §7: ONE call for the whole queue
    expect(provider.started[0]?.deviceId).toBe('dev1');
    const uris = provider.started[0]?.uris ?? [];
    expect(uris).toHaveLength(3);
    expect([...uris].sort()).toEqual(['spotify:track:t1', 'spotify:track:t2', 'spotify:track:t3']);
    expect(frames.length).toBeGreaterThanOrEqual(2); // transition + mode broadcast
    expect(orch.buildSnapshot(code, viewer('x', 'host'))?.playbackMode).toBe('api');
  });

  it('manual mode when no live Spotify session exists', async () => {
    const provider = new StubProvider();
    const { orch, code, fsm } = lockedRoom({
      provider,
      probe: deadProbe,
      rows: (c) => [sub(c, 0, 'a', 't1')],
    });
    await driveToLocked(fsm);
    await fsm.dispatch('BEGIN_PLAYBACK');
    await tick(20);
    expect(provider.started).toHaveLength(0);
    expect(orch.buildSnapshot(code, viewer('x', 'host'))?.playbackMode).toBe('manual');
  });

  it('manual mode when no active device (L4 first-class)', async () => {
    const provider = new StubProvider();
    provider.device = null;
    const { orch, code, fsm } = lockedRoom({
      provider,
      probe: liveProbe,
      rows: (c) => [sub(c, 0, 'a', 't1')],
    });
    await driveToLocked(fsm);
    await fsm.dispatch('BEGIN_PLAYBACK');
    await tick(20);
    expect(provider.started).toHaveLength(0);
    expect(orch.buildSnapshot(code, viewer('x', 'host'))?.playbackMode).toBe('manual');
  });
});

// ── Queue done → placeholder judge → RESULTS ─────────────────────────────────

describe('QUEUE_DONE → AI_JUDGING → placeholder JUDGEMENT_STORED', () => {
  it('poll detects playback past the last queue track and reaches RESULTS', async () => {
    const provider = new StubProvider();
    const { orch, code, fsm } = lockedRoom({
      provider,
      probe: liveProbe,
      rows: (c) => [sub(c, 0, 'a', 't1'), sub(c, 0, 'b', 't2')],
      pollMs: 10,
    });
    await driveToLocked(fsm);
    await fsm.dispatch('BEGIN_PLAYBACK');
    await tick(40);
    expect(fsm.state).toBe('PLAYBACK');

    // Last queued track playing → then something outside the queue → done.
    provider.state = { isPlaying: true, progressMs: 29_000, trackId: 't2', deviceId: 'dev1' };
    await tick(60);
    provider.state = {
      isPlaying: true,
      progressMs: 1_000,
      trackId: 'unrelated-track',
      deviceId: 'dev1',
    };
    await tick(200);
    expect(fsm.state).toBe('RESULTS'); // QUEUE_DONE fired; judge stored immediately

    const hostSnap = orch.buildSnapshot(code, viewer('a', 'host'));
    expect(hostSnap?.you.hasSubmitted).toBe(true);
  });

  it('device-loss grace falls back to manual instead of hanging the round', async () => {
    const provider = new StubProvider();
    const { orch, code, fsm } = lockedRoom({
      provider,
      probe: liveProbe,
      rows: (c) => [sub(c, 0, 'a', 't1')],
      pollMs: 10,
    });
    await driveToLocked(fsm);
    await fsm.dispatch('BEGIN_PLAYBACK');
    await tick(20);
    provider.state = null; // three dead polls ⇒ manual fallback
    await tick(120);
    expect(fsm.state).toBe('PLAYBACK'); // NOT force-advanced by device loss
    expect(orch.buildSnapshot(code, viewer('x', 'host'))?.playbackMode).toBe('manual');
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
