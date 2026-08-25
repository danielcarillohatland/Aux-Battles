/**
 * Phase 3 player tests: song search client, submission client, and the
 * realtime `submissionCount` signal fed by snapshot + submission_received
 * count frames. Scripted fake fetch/WebSocket — no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { searchTracks, submitTrack } from '../src/player/api.js';
import { createPlayerRealtime } from '../src/player/ws.js';

const CODE = 'ABCDE';

const TRACK_A = {
  id: 'spotify:track:aaa',
  title: 'Fast Car',
  artist: 'Tracy Chapman',
  album: null,
  durationMs: 297000,
  artUrl: null,
};
const TRACK_B = { id: 't2', title: 'Song B', artist: 'B' };

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

let fetchCalls: { url: string; init?: RequestInit }[] = [];

beforeEach(() => {
  fetchCalls = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  vi.stubGlobal('fetch', (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    return Promise.resolve(handler(urlStr, init)).then((res) => {
      fetchCalls.push({ url: urlStr, init });
      return res;
    });
  });
}

describe('searchTracks', () => {
  it('reports unavailable on 404 (endpoint not deployed yet)', async () => {
    stubFetch(() => jsonResponse(404, { ok: false }));
    const outcome = await searchTracks('fast car');
    expect(outcome).toEqual({ status: 'unavailable' });
    expect(fetchCalls[0]?.url).toBe('/api/v1/search?q=fast%20car&limit=10');
  });

  it('parses the ok envelope and caps results at 10', async () => {
    const many = Array.from({ length: 14 }, (_, i) => ({
      id: `id-${i}`,
      title: `T${i}`,
      artist: 'A',
    }));
    stubFetch(() => jsonResponse(200, { ok: true, data: { tracks: many } }));
    const outcome = await searchTracks('x');
    expect(outcome.status).toBe('ok');
    if (outcome.status === 'ok') expect(outcome.tracks.length).toBe(10);
  });

  it('tolerates backend-spec field names (trackId/albumArt) and dedupes', async () => {
    stubFetch(() =>
      jsonResponse(200, { ok: true, data: { tracks: [TRACK_A, { ...TRACK_A }, TRACK_B] } }),
    );
    const outcome = await searchTracks('q');
    expect(outcome.status).toBe('ok');
    if (outcome.status === 'ok')
      expect(outcome.tracks.map((t) => t.id)).toEqual([TRACK_A.id, TRACK_B.id]);
  });

  it('maps network failure to an error outcome', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
    const outcome = await searchTracks('q');
    expect(outcome.status).toBe('error');
  });
});

describe('submitTrack', () => {
  const session = {
    playerToken: 'tok_tok_tok_tok_tok',
    playerId: 'p1',
    nickname: 'DJ',
    code: CODE,
  };

  it('POSTs to the room submissions endpoint with bearer + idempotency key', async () => {
    stubFetch(() =>
      jsonResponse(201, {
        ok: true,
        data: { submissionId: 'sb_1', submittedCount: 4, expectedCount: 6 },
      }),
    );
    const result = await submitTrack(session, TRACK_A as never, 0);
    expect(result.ok).toBe(true);
    const call = fetchCalls[0];
    expect(call.url).toBe(`/api/v1/rooms/${CODE}/rounds/0/submissions`);
    expect((call.init?.headers as Record<string, string>).authorization).toBe(
      `Bearer ${session.playerToken}`,
    );
    const body = JSON.parse(String(call.init?.body));
    expect(body.clientMsgId.length).toBeGreaterThanOrEqual(8);
    expect(body.track.id).toBe(TRACK_A.id);
    expect(body.title).toBe(TRACK_A.title); // flattened fallback fields present too
  });

  it('maps ALREADY_SUBMITTED and TOO_LATE precisely', async () => {
    stubFetch(() =>
      jsonResponse(409, { ok: false, error: { code: 'ALREADY_SUBMITTED', message: '' } }),
    );
    let result = await submitTrack(session, TRACK_A as never, 0);
    expect(result).toEqual({ ok: false, failure: { kind: 'already_submitted' } });

    stubFetch(() => jsonResponse(409, { ok: false, error: { code: 'TOO_LATE', message: '' } }));
    result = await submitTrack(session, TRACK_A as never, 0);
    expect(result).toEqual({ ok: false, failure: { kind: 'too_late' } });
  });

  it('treats network errors as retryable other-failures', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
    const result = await submitTrack(session, TRACK_A as never, 0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe('other');
  });
});

// ── Realtime submissionCount plumbing ──────────────────────────────────────────

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  receive(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
}

function snap(submissionsCount: number) {
  return {
    t: 'state_change',
    ts: Date.now(),
    seq: 1,
    snapshot: {
      roomCode: CODE,
      state: 'SONG_SELECTION',
      roundIdx: 0,
      phaseEndsAt: null,
      playbackMode: 'api',
      players: [{ nickname: 'a', connected: true }],
      submissionsCount,
      you: { role: 'player', hasSubmitted: false, nickname: 'a' },
    },
  };
}

describe('player realtime submissionCount', () => {
  it('seeds from snapshots and nudges live off submission_received frames', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
    vi.stubGlobal('location', { protocol: 'http:', host: 'test.local' });
    stubFetch((url) =>
      url.includes('ws-ticket')
        ? jsonResponse(200, { ok: true, data: { ticket: 'tkt123' } })
        : jsonResponse(404, {}),
    );

    const rt = createPlayerRealtime({ code: CODE, playerToken: 'tok_tok_tok_tok_tok' });
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
    const sock = FakeWebSocket.instances.at(-1)!;
    sock.readyState = 1;
    sock.onopen?.();

    sock.receive(snap(2));
    expect(rt.submissionCount()).toBe(2);

    // Count-only anonymity frame lands before the next snapshot:
    const ts = Date.now();
    sock.receive({ t: 'submission_received', count: 3, ts, seq: 2 });
    expect(rt.submissionCount()).toBe(3);

    rt.stop();
  });
});
