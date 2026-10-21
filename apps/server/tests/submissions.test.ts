/**
 * Phase 3 submission engine tests (TDD §4-§6): SubmissionStore unit behavior
 * + rounds route wire contract via fastify inject with controller seams faked
 * (getRoomPhase / dispatchAllSubmitted / broadcastSubmissionCount are exactly
 * the seams index.ts will wire to game-runtimes' live FSM).
 */
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { AlreadySubmittedError, SubmissionStore } from '../src/core/submissions.js';
import {
  canonicalManualTrack,
  roundsRoute,
  submitRandomForMissing,
  parseRoundId,
} from '../src/routes/rounds.js';
import { RoomManager } from '../src/core/room-manager.js';
import type { Track } from '@aux/shared';
import { MusicCatalogError, type ApprovedMusicCatalog } from '../src/providers/music-provider.js';

const TRACK_A: Track = { id: 't1', title: 'Song A', artist: 'Artist A' };
const TRACK_B: Track = { id: 't2', title: 'Song B', artist: 'Artist B' };
const TEST_TRACKS = new Map([TRACK_A, TRACK_B].map((track) => [track.id, track]));
const TEST_CATALOG: ApprovedMusicCatalog = {
  search: async () => [...TEST_TRACKS.values()],
  listTracks: () => [...TEST_TRACKS.values()],
  async getTrack(id) {
    const track = TEST_TRACKS.get(id);
    if (track === undefined) throw new MusicCatalogError('TRACK_UNPLAYABLE');
    return { ...track, source: 'original', attribution: 'Test-owned original' };
  },
  playableTrack({ id }) {
    const track = TEST_TRACKS.get(id);
    return track === undefined ? null : { ...track, source: 'original' };
  },
};

function makeRoom() {
  const roomManager = new RoomManager();
  const host = roomManager.createRoom();
  const p1 = roomManager.joinRoom(host.code, 'Alice');
  const p2 = roomManager.joinRoom(host.code, 'Bob');
  return { roomManager, code: host.code, hostToken: host.hostToken, p1, p2 };
}

describe('SubmissionStore', () => {
  it('stores a sanitized, bounded defense with the submission', () => {
    const store = new SubmissionStore();
    const res = store.submit({
      code: 'ABC23',
      roundIdx: 0,
      playerId: 'p1',
      clientMsgId: 'cmid-defense-1',
      track: TRACK_A,
      defense: '  because\u0000 the   drop hits\n exactly when the door opens ' + 'x'.repeat(400),
    });
    expect(res.submission.defense).toMatch(
      /^because the drop hits exactly when the door opens x+$/,
    );
    expect(res.submission.defense?.length).toBe(160);
    const silent = store.submit({
      code: 'ABC23',
      roundIdx: 0,
      playerId: 'p2',
      clientMsgId: 'cmid-defense-2',
      track: TRACK_B,
      defense: '   ',
    });
    expect(silent.submission).not.toHaveProperty('defense');
  });

  it('stores a submission and reports count', () => {
    const store = new SubmissionStore();
    const res = store.submit({
      code: 'ABC23',
      roundIdx: 0,
      playerId: 'p1',
      clientMsgId: 'msg-0001-p1',
      track: TRACK_A,
    });
    expect(res.status).toBe('stored');
    expect(res.count).toBe(1);
  });

  it('replays the ORIGINAL result for a repeated clientMsgId (idempotency)', () => {
    const store = new SubmissionStore();
    const first = store.submit({
      code: 'ABC23',
      roundIdx: 0,
      playerId: 'p1',
      clientMsgId: 'msg-0001-p1',
      track: TRACK_A,
    });
    const replay = store.submit({
      code: 'ABC23',
      roundIdx: 0,
      playerId: 'p1',
      clientMsgId: 'msg-0001-p1',
      track: TRACK_B,
    });
    expect(replay.status).toBe('replayed');
    expect(replay.submission.track.id).toBe(first.submission.track.id); // original kept, not TRACK_B
    expect(store.count('ABC23:0')).toBe(1);
  });

  it('throws ALREADY_SUBMITTED for a different clientMsgId from the same player', () => {
    const store = new SubmissionStore();
    store.submit({
      code: 'ABC23',
      roundIdx: 0,
      playerId: 'p1',
      clientMsgId: 'msg-0001-p1',
      track: TRACK_A,
    });
    expect(() =>
      store.submit({
        code: 'ABC23',
        roundIdx: 0,
        playerId: 'p1',
        clientMsgId: 'msg-9999-p1',
        track: TRACK_B,
      }),
    ).toThrowError(AlreadySubmittedError);
  });

  it('fires onChanged(code) on mutation only — checkpoint seam', () => {
    const store = new SubmissionStore();
    const seen: string[] = [];
    store.onChanged = (code) => seen.push(code);
    store.submit({
      code: 'ABC23',
      roundIdx: 0,
      playerId: 'p1',
      clientMsgId: 'msg-0001-p1',
      track: TRACK_A,
    });
    store.submit({
      code: 'ABC23',
      roundIdx: 0,
      playerId: 'p1',
      clientMsgId: 'msg-0001-p1',
      track: TRACK_A,
    }); // replay → no fire
    expect(seen).toEqual(['ABC23']);
  });

  it('fillChickens auto-fills only connected non-submitters as 🐔', () => {
    const store = new SubmissionStore();
    store.setChickenTracks([TRACK_A, TRACK_B]);
    store.submit({
      code: 'ABC23',
      roundIdx: 0,
      playerId: 'p1',
      clientMsgId: 'msg-0001-p1',
      track: TRACK_A,
    });
    const filled = store.fillChickens('ABC23', 0, ['p1', 'p2', 'p3']);
    expect(filled.map((s) => s.playerId)).toEqual(['p2', 'p3']);
    expect(filled.every((s) => s.chicken)).toBe(true);
    for (const t of filled) {
      expect(t.track.title.length).toBeGreaterThan(0);
      expect(t.track.artist.length).toBeGreaterThan(0);
    }
    expect(store.count('ABC23:0')).toBe(3);
  });

  it('serialize/hydrate round-trips both uniqueness axes', () => {
    const a = new SubmissionStore();
    a.submit({
      code: 'ABC23',
      roundIdx: 2,
      playerId: 'p1',
      clientMsgId: 'msg-0001-p1',
      track: TRACK_A,
    });
    const payload = a.serialize('ABC23');
    const b = new SubmissionStore();
    b.hydrate(payload);
    expect(b.count('ABC23:2')).toBe(1);
    // Uniqueness survives rehydration:
    expect(() =>
      b.submit({
        code: 'ABC23',
        roundIdx: 2,
        playerId: 'p1',
        clientMsgId: 'other-msg-99',
        track: TRACK_B,
      }),
    ).toThrowError(AlreadySubmittedError);
    const replay = b.submit({
      code: 'ABC23',
      roundIdx: 2,
      playerId: 'pX',
      clientMsgId: 'msg-0001-p1',
      track: TRACK_B,
    });
    expect(replay.status).toBe('replayed'); // clientMsgId axis too
  });
});

describe('rounds route', () => {
  function buildPlugin() {
    const room = makeRoom();
    const code = room.code;
    const submissions = new SubmissionStore();
    submissions.setChickenTracks(TEST_CATALOG.listTracks());
    let phaseState = 'SONG_SELECTION';
    let roundIdx = 0;
    const broadcasts: Array<{ code: string; count: number }> = [];
    const dispatched: string[] = [];
    const plugin = roundsRoute({
      roomManager: room.roomManager,
      submissions,
      catalog: TEST_CATALOG,
      getRoomPhase: (c) => (c === code ? { state: phaseState as never, roundIdx } : null),
      dispatchAllSubmitted: async (c) => {
        dispatched.push(c);
        phaseState = 'LOCKED';
        return true;
      },
      broadcastSubmissionCount: (c, count) => broadcasts.push({ code: c, count }),
    });
    return {
      ...room,
      submissions,
      plugin,
      broadcasts,
      dispatched,
      setPhase: (s: string, r = 0) => {
        phaseState = s;
        roundIdx = r;
      },
    };
  }

  async function submit(
    app: { inject: (o: unknown) => PromiseLike<{ statusCode: number; json(): unknown }> },
    url: string,
    token: string,
    body: unknown,
  ) {
    return app.inject({
      method: 'POST',
      url,
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });
  }

  it('accepts a submission, broadcasts COUNT ONLY, fires quorum at full count', async () => {
    const ctx = buildPlugin();
    const app = Fastify();
    await app.register(ctx.plugin, { prefix: '/api/v1' });

    const body = { clientMsgId: 'msg-aaaa-p1', track: TRACK_A };
    let res = await submit(
      app,
      `/api/v1/rooms/${ctx.code}/rounds/0/submissions`,
      ctx.p1.playerToken,
      body,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, data: { count: 1, replayed: false } });

    // Anonymity: broadcast carries a count, never an identity.
    expect(ctx.broadcasts).toEqual([{ code: ctx.code, count: 1 }]);

    // Third submission reaches quorum (host + 2 players all connected) →
    // ALL_SUBMITTED dispatched exactly once.
    await submit(app, `/api/v1/rounds/${ctx.code}:0/submissions`, ctx.hostToken, {
      clientMsgId: 'msg-zzzz-h0',
      track: TRACK_B,
    });
    res = await submit(app, `/api/v1/rounds/${ctx.code}:0/submissions`, ctx.p2.playerToken, {
      clientMsgId: 'msg-bbbb-p2',
      track: TRACK_B,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, data: { count: 2 } });
    expect(ctx.dispatched).toEqual([ctx.code]);
    await app.close();
  });

  it('rejects wrong-state submissions with 409 INVALID_ACTION', async () => {
    const ctx = buildPlugin();
    const app = Fastify();
    await app.register(ctx.plugin, { prefix: '/api/v1' });
    ctx.setPhase('PLAYBACK');
    const res = await submit(app, `/api/v1/rounds/${ctx.code}:0/submissions`, ctx.p1.playerToken, {
      clientMsgId: 'msg-cccc-p1',
      track: TRACK_A,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ ok: false, error: { code: 'INVALID_ACTION' } });
    await app.close();
  });

  it('returns 409 ALREADY_SUBMITTED on a second song, 200 replay on same clientMsgId', async () => {
    const ctx = buildPlugin();
    const app = Fastify();
    await app.register(ctx.plugin, { prefix: '/api/v1' });
    const url = `/api/v1/rounds/${ctx.code}:0/submissions`;
    await submit(app, url, ctx.p1.playerToken, { clientMsgId: 'msg-dddd-p1', track: TRACK_A });

    const dup = await submit(app, url, ctx.p1.playerToken, {
      clientMsgId: 'msg-eeee-p1',
      track: TRACK_B,
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toMatchObject({ ok: false, error: { code: 'ALREADY_SUBMITTED' } });

    const replay = await submit(app, url, ctx.p1.playerToken, {
      clientMsgId: 'msg-dddd-p1',
      track: TRACK_B,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ ok: true, data: { replayed: false } });
    await app.close();
  });

  it('requires a valid Bearer player token (401)', async () => {
    const ctx = buildPlugin();
    const app = Fastify();
    await app.register(ctx.plugin, { prefix: '/api/v1' });
    const noAuth = await submit(
      app,
      `/api/v1/rounds/${ctx.code}:0/submissions`,
      'not-a-real-token-at-all!!',
      {
        clientMsgId: 'msg-ffff-p1',
        track: TRACK_A,
      },
    );
    expect(noAuth.statusCode).toBe(401);
    expect(noAuth.json()).toMatchObject({ ok: false, error: { code: 'NOT_AUTHENTICATED' } });
    const badBody = await submit(
      app,
      `/api/v1/rounds/${ctx.code}:0/submissions`,
      ctx.p1.playerToken,
      { nope: 1 },
    );
    expect(badBody.statusCode).toBe(400);
    await app.close();
  });

  it('canonicalizes catalog picks, rejects unknown ids, and safely accepts manual picks', async () => {
    const ctx = buildPlugin();
    const app = Fastify();
    await app.register(ctx.plugin, { prefix: '/api/v1' });
    const url = `/api/v1/rounds/${ctx.code}:0/submissions`;
    const accepted = await submit(app, url, ctx.p1.playerToken, {
      clientMsgId: 'msg-canon-p1',
      track: { id: TRACK_A.id, title: 'Tampered Title', artist: 'Unknown Upload' },
    });
    expect(accepted.statusCode).toBe(200);
    expect(ctx.submissions.list(`${ctx.code}:0`)[0]?.track).toMatchObject({
      title: TRACK_A.title,
      artist: TRACK_A.artist,
      source: 'original',
    });

    const rejected = await submit(app, url, ctx.p2.playerToken, {
      clientMsgId: 'msg-external-p2',
      track: { id: 'external:not-approved', title: 'Unknown', artist: 'Unknown' },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json()).toMatchObject({ ok: false, error: { code: 'INVALID_ACTION' } });

    const manual = await submit(app, url, ctx.p2.playerToken, {
      clientMsgId: 'msg-manual-p2',
      track: {
        id: 'manual:client-placeholder',
        title: '  Dreams  ',
        artist: ' Fleetwood Mac ',
        source: 'manual',
        artUrl: 'https://example.invalid/untrusted.jpg',
        externalUrl: 'https://example.invalid/untrusted',
      },
    });
    expect(manual.statusCode).toBe(200);
    const storedManual = ctx.submissions.list(`${ctx.code}:0`)[1]?.track;
    expect(storedManual).toMatchObject({
      title: 'Dreams',
      artist: 'Fleetwood Mac',
      source: 'manual',
      attribution: 'Song details entered by a player',
    });
    expect(storedManual?.id).toMatch(/^manual:[a-f0-9]{20}$/);
    expect(storedManual).not.toHaveProperty('artUrl');
    expect(storedManual).not.toHaveProperty('externalUrl');
    await app.close();
  });

  it('submitRandomForMissing fills connected non-submitters only', () => {
    const ctx = buildPlugin();
    ctx.submissions.submit({
      code: ctx.code,
      roundIdx: 0,
      playerId: ctx.p1.playerId,
      clientMsgId: 'msg-gggg-p1',
      track: TRACK_A,
    });
    const summary = submitRandomForMissing(ctx.code, `${ctx.code}:0`, {
      roomManager: ctx.roomManager,
      submissions: ctx.submissions,
    });
    expect(summary.filledCount).toBe(1); // p2 only; the host is not a contestant
    expect(summary.totalSubmissions).toBe(2);
    const subs = ctx.submissions.list(`${ctx.code}:0`);
    expect(subs.filter((s) => s.chicken).length).toBe(summary.filledCount);
  });
});

describe('parseRoundId', () => {
  it('splits composite ids and rejects malformed ones', () => {
    expect(parseRoundId('ABC23:1')).toEqual({ code: 'ABC23', roundIdx: 1 });
    expect(parseRoundId('nope')).toBeNull();
    expect(parseRoundId('AB23:0')).toBeNull(); // 4 chars — invalid code
    expect(parseRoundId('ABC23:x')).toBeNull();
  });
});

describe('canonicalManualTrack', () => {
  it('uses a stable server-owned identity for equivalent player text', () => {
    const first = canonicalManualTrack({
      id: 'manual:first',
      title: ' Dreams ',
      artist: 'FLEETWOOD MAC',
      source: 'manual',
    });
    const second = canonicalManualTrack({
      id: 'manual:second',
      title: 'dreams',
      artist: 'fleetwood mac',
      source: 'manual',
    });
    expect(first?.id).toBe(second?.id);
  });
});
