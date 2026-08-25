/**
 * Unit tests for the host realtime client (D-D contract):
 * handshake failure → exponential backoff → polling fallback;
 * 15s heartbeat pings; seq-gap → fresh-handshake resync; local countdown.
 * Uses a scripted fake WebSocket + fetch — no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHostRealtime } from '../src/host/ws.js';

const CODE = 'ABCDE';

function snapshotData(overrides: Record<string, unknown> = {}) {
  return {
    roomCode: CODE,
    state: 'LOBBY',
    roundIdx: 0,
    phaseEndsAt: null,
    playbackMode: 'api',
    players: [{ nickname: 'Hosty', connected: true }],
    submissionsCount: 0,
    you: { role: 'host', hasSubmitted: false, nickname: 'Hosty' },
    ...overrides,
  };
}

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
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.();
  }
  // Test hooks
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Install a fetch router over the REST surface the client touches. */
let ticketFailures = 0;
function installFetch() {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url.includes('/ws-ticket')) {
      if (ticketFailures > 0) {
        ticketFailures -= 1;
        return jsonResponse(503, { ok: false, error: { code: 'INTERNAL', message: 'x' } });
      }
      return jsonResponse(200, { ok: true, data: { ticket: 'tkn-' + calls.length } });
    }
    if (url.includes('/snapshot')) {
      return jsonResponse(200, { ok: true, data: snapshotData() });
    }
    return jsonResponse(404, { ok: false, error: { code: 'INVALID_CODE', message: '?' } });
  });
  return calls;
}

async function flush(times = 6) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  ticketFailures = 0;
  vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
  vi.stubGlobal('location', { protocol: 'http:', host: 'test.local' });
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('createHostRealtime', () => {
  it('degrades to polling fallback after repeated failed handshakes', async () => {
    installFetch();
    ticketFailures = 99; // every ticket request fails

    const rt = createHostRealtime({ code: CODE, hostToken: 'host-tok' });
    await flush();

    // Backoff ladder: ~500ms, ~1s, then ≥3rd attempt trips the fallback.
    await vi.advanceTimersByTimeAsync(900);
    expect(rt.connState()).not.toBe('polling');
    await vi.advanceTimersByTimeAsync(1200);
    await vi.advanceTimersByTimeAsync(2500);

    expect(rt.connState()).toBe('polling');
    expect(rt.snapshot()?.players.length).toBe(1); // fed by REST polling
    expect(rt.everLive()).toBe(false);
    rt.stop();
  });

  it('handshakes, receives state_change, and sends 15s heartbeat pings', async () => {
    const calls = installFetch();
    const rt = createHostRealtime({ code: CODE, hostToken: 'host-tok' });
    await flush();

    expect(calls.some((u) => u.includes('/api/v1/ws-ticket'))).toBe(true);
    const sock = FakeWebSocket.instances[0];
    expect(sock.url).toContain('/ws?room=ABCDE');
    expect(sock.url).toContain('ticket=tkn-');

    sock.open();
    sock.receive({
      t: 'state_change',
      ts: 1,
      seq: 4,
      snapshot: snapshotData(),
    });

    expect(rt.connState()).toBe('live');
    expect(rt.snapshot()?.players[0]?.nickname).toBe('Hosty');

    await vi.advanceTimersByTimeAsync(15_000);
    const pings = sock.sent.filter((m) => JSON.parse(m).t === 'ping');
    expect(pings.length).toBe(1);
    expect(typeof JSON.parse(pings[0]).ts).toBe('number');

    // timer_tick frames are ignored — countdown stays derived from phaseEndsAt.
    sock.receive({ t: 'timer_tick', ts: 2, seq: 5, phaseEndsAt: Date.now() + 60_000 });
    expect(rt.countdownSeconds()).toBeNull();
    rt.stop();
  });

  it('renders countdown locally from absolute phaseEndsAt (D-C)', async () => {
    installFetch();
    const rt = createHostRealtime({ code: CODE, hostToken: 'host-tok' });
    await flush();
    const sock = FakeWebSocket.instances[0];
    sock.open();
    sock.receive({
      t: 'state_change',
      ts: 1,
      seq: 1,
      snapshot: snapshotData({ phaseEndsAt: Date.now() + 10_000 }),
    });

    const left = rt.countdownSeconds();
    expect(left).toBeGreaterThanOrEqual(9);
    expect(left).toBeLessThanOrEqual(10);

    await vi.advanceTimersByTimeAsync(10_500);
    expect(rt.countdownSeconds()).toBe(0);
    rt.stop();
  });

  it('detects seq gaps and repairs via a fresh handshake (no resync frame)', async () => {
    installFetch();
    const rt = createHostRealtime({ code: CODE, hostToken: 'host-tok' });
    await flush();
    const sock1 = FakeWebSocket.instances[0];
    sock1.open();
    sock1.receive({ t: 'state_change', ts: 1, seq: 7, snapshot: snapshotData() });
    expect(rt.connState()).toBe('live');

    // Gap: 7 → 10 means frames 8,9 were lost. Repair = drop socket, redial.
    sock1.receive({ t: 'state_change', ts: 2, seq: 10, snapshot: snapshotData() });
    await flush();
    await vi.advanceTimersByTimeAsync(1); // resync reconnect is scheduled at 0ms

    expect(sock1.readyState).toBe(3);
    expect(FakeWebSocket.instances.length).toBe(2); // fresh socket minted
    const sock2 = FakeWebSocket.instances[1];
    sock2.open();
    // Resync frame arrives with ANY seq (fresh handshake resets expectations).
    sock2.receive({ t: 'state_change', ts: 3, seq: 11, snapshot: snapshotData() });
    expect(rt.connState()).toBe('live');
    expect(rt.snapshot()?.players[0]?.nickname).toBe('Hosty');
    rt.stop();
  });

  it('surfaces room_closed as a terminal event without reconnecting', async () => {
    installFetch();
    let terminal: { kind: string; reason: string } | null = null;
    const rt = createHostRealtime({
      code: CODE,
      hostToken: 'host-tok',
      onTerminal: (ev) => (terminal = ev),
    });
    await flush();
    const sock = FakeWebSocket.instances[0];
    sock.open();
    sock.receive({ t: 'room_closed', ts: 1, seq: 2, reason: 'expired' });

    expect(terminal).toEqual({ kind: 'room_closed', reason: 'expired' });
    expect(rt.connState()).toBe('closed');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(FakeWebSocket.instances.length).toBe(1); // no redial after terminal
    rt.stop();
  });
});
