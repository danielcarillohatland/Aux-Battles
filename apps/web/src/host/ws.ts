/**
 * AUX BATTLES — host realtime client (TDD §9 + D-D).
 *
 * Wire model (D-D): REST mutates, WS informs. One WebSocket per client:
 *   1. POST /api/v1/ws-ticket  {code} + Bearer hostToken → {ok,data:{ticket}}
 *   2. new WebSocket(`${ws(s)://host}/ws?room=${code}&ticket=${ticket}`)
 *   3. server pushes `state_change` frames carrying a FULL snapshot.
 *
 * Resilience contract:
 *   - 15 s app-level ping heartbeat (`{t:'ping',ts}`); a watchdog treats
 *     HEARTBEAT_STALE_MS of total silence as a dead socket → reconnect.
 *   - Reconnect = fresh handshake (new ticket, new socket) with exponential
 *     backoff + jitter. There is NO `resync` frame — a fresh handshake's first
 *     `state_change` IS the resync (D-D).
 *   - Seq gaps (frame.seq > lastSeq+1) mean missed frames → same repair:
 *     drop the socket and re-handshake.
 *   - Countdowns render locally from snapshot.phaseEndsAt (D-C); `timer_tick`
 *     frames are intentionally ignored.
 *   - State store is REPLACE-NEVER-MERGE: every state_change swaps the whole
 *     snapshot object; nothing is patched field-by-field.
 *   - If WS can't be established at all, fall back to snapshot polling and
 *     keep retrying WS quietly in the background.
 */
import { createSignal } from 'solid-js';
import { HEARTBEAT_INTERVAL_MS, ServerFrameSchema } from '@aux/shared';
import type { ServerFrame, Snapshot } from '@aux/shared';
import { apiRequest, HostApiError } from './api.js';

// ── Tunables ──────────────────────────────────────────────────────────────────

const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 8_000;
const BACKOFF_JITTER_MS = 250;
/** Silence longer than this ⇒ the socket is a zombie; force-close and redial. */
const HEARTBEAT_STALE_MS = HEARTBEAT_INTERVAL_MS * 2 + 5_000;
/** Consecutive failed handshakes before we degrade to polling fallback. */
const MAX_WS_ATTEMPTS = 3;
/** While in polling fallback, how often we probe for a working WS again. */
const WS_RETRY_WHILE_POLLING_MS = 30_000;
const POLL_INTERVAL_MS = 2_000;

export type ConnState =
  | 'connecting' // handshake in flight (ticket + socket)
  | 'live' // WS open and delivering frames
  | 'reconnecting' // WS dropped; backoff before redial
  | 'polling' // WS unavailable — REST snapshot fallback
  | 'closed'; // stopped locally

export type TerminalEvent = { kind: 'room_closed' | 'kicked'; reason: string };

export interface RealtimeHandle {
  /** Full server state, replaced wholesale on every state_change. */
  readonly snapshot: () => Snapshot | null;
  readonly connState: () => ConnState;
  /**
   * Seconds remaining in the current phase, computed LOCALLY from the absolute
   * `phaseEndsAt` deadline (D-C). Null when the phase isn't timed or time is up.
   */
  readonly countdownSeconds: () => number | null;
  /** True once the socket has proven itself (first frame received). */
  readonly everLive: () => boolean;
  stop: () => void;
}

interface RealtimeOptions {
  code: string;
  hostToken: string;
  /** Room vanished while we were in polling fallback (WS would send room_closed). */
  onRoomGone?: () => void;
  onTerminal?: (event: TerminalEvent) => void;
}

// ── Engine ────────────────────────────────────────────────────────────────────

export function createHostRealtime(opts: RealtimeOptions): RealtimeHandle {
  const [snapshot, setSnapshot] = createSignal<Snapshot | null>(null);
  const [connState, setConnState] = createSignal<ConnState>('connecting');
  const [countdownSeconds, setCountdownSeconds] = createSignal<number | null>(null);
  const [everLive, setEverLive] = createSignal(false);

  let ws: WebSocket | null = null;
  let stopped = false;
  let lastSeq: number | null = null;
  let lastFrameAt = 0;
  let wsAttempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let watchdogTimer: ReturnType<typeof setInterval> | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let countdownTimer: ReturnType<typeof setInterval> | undefined;

  // ── Countdown (local, from absolute deadline — D-C) ────────────────────────

  const tickCountdown = () => {
    const endsAt = snapshot()?.phaseEndsAt ?? null;
    if (endsAt === null) {
      setCountdownSeconds(null);
      return;
    }
    const remainingMs = endsAt - Date.now();
    setCountdownSeconds(remainingMs <= 0 ? 0 : Math.ceil(remainingMs / 1000));
  };

  const startCountdown = () => {
    if (countdownTimer !== undefined) return;
    tickCountdown();
    countdownTimer = setInterval(tickCountdown, 250);
  };

  // ── Polling fallback (keeps the UI alive when WS can't be had) ─────────────

  const pollSnapshot = async () => {
    try {
      const snap = await apiRequest<Snapshot>(
        `/api/v1/rooms/${encodeURIComponent(opts.code)}/snapshot`,
        { headers: { authorization: `Bearer ${opts.hostToken}` } },
      );
      if (stopped) return;
      applySnapshot(snap);
    } catch (err) {
      if (
        err instanceof HostApiError &&
        (err.code === 'ROOM_NOT_FOUND' || err.code === 'ROOM_CLOSED')
      ) {
        opts.onRoomGone?.();
      }
      /* other errors are transient — next poll retries */
    }
  };

  const startPolling = () => {
    if (pollTimer !== undefined || stopped) return;
    setConnState('polling');
    void pollSnapshot();
    pollTimer = setInterval(() => void pollSnapshot(), POLL_INTERVAL_MS);
    // Quietly keep probing for a recoverable WS while polling.
    scheduleReconnect(WS_RETRY_WHILE_POLLING_MS);
  };

  const stopPolling = () => {
    if (pollTimer !== undefined) {
      clearInterval(pollTimer);
      pollTimer = undefined;
    }
  };

  // ── Frame application (replace-never-merge) ────────────────────────────────

  const applySnapshot = (snap: Snapshot) => {
    setSnapshot(snap); // whole-object swap; consumers re-derive everything
    startCountdown();
  };

  const handleFrame = (raw: unknown) => {
    lastFrameAt = Date.now();
    if (!ServerFrameSchema.safeParse(raw).success) return; // unknown/malformed: ignore
    const frame = raw as ServerFrame;

    switch (frame.t) {
      case 'state_change': {
        // Gap detection (D-D): seq is per-room monotonic; a jump means frames
        // were lost. Repair by fresh handshake — its first state_change resyncs.
        if (lastSeq !== null && frame.seq > lastSeq + 1) {
          resync();
          return;
        }
        lastSeq = frame.seq;
        applySnapshot(frame.snapshot);
        return;
      }
      case 'timer_tick':
        return; // deliberately ignored — countdown derives from phaseEndsAt (D-C)
      case 'submission_received':
        return; // informational only; authoritative count arrives via state_change
      case 'playback_cue':
      case 'judgement':
      case 'reveal_owner':
        return; // Phase 2.5 / Phase 4 payloads land later
      case 'room_closed':
      case 'kicked':
        terminate(frame.t, frame.reason);
        return;
    }
  };

  // ── Handshake lifecycle ────────────────────────────────────────────────────

  const clearTimers = () => {
    if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
    if (watchdogTimer !== undefined) clearInterval(watchdogTimer);
    heartbeatTimer = watchdogTimer = undefined;
  };

  const teardownSocket = () => {
    clearTimers();
    if (ws !== null) {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      try {
        ws.close();
      } catch {
        /* already closing */
      }
      ws = null;
    }
  };

  const connect = async () => {
    if (stopped) return;
    teardownSocket();
    setConnState('connecting');

    // Connect-ticket flow: short-lived one-time ticket keeps the long-lived
    // session token out of upgrade URLs/logs. Endpoint owned by backend (§9).
    let ticket: string;
    try {
      const data = await apiRequest<{ ticket: string }>('/api/v1/ws-ticket', {
        method: 'POST',
        headers: { authorization: `Bearer ${opts.hostToken}` },
        body: JSON.stringify({ code: opts.code }),
      });
      ticket = data.ticket;
    } catch {
      return onHandshakeFailed();
    }

    if (stopped) return;

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let socket: WebSocket;
    try {
      socket = new WebSocket(
        `${proto}//${location.host}/ws?room=${encodeURIComponent(opts.code)}&ticket=${encodeURIComponent(ticket)}`,
      );
    } catch {
      return onHandshakeFailed();
    }
    ws = socket;

    socket.onmessage = (ev) => {
      if (socket !== ws) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (!everLive()) {
        setEverLive(true);
        wsAttempts = 0;
        stopPolling(); // WS works again — polling fallback stands down
      }
      setConnState('live');
      handleFrame(parsed);
    };

    socket.onclose = () => {
      if (socket !== ws || stopped) return;
      teardownSocket();
      onHandshakeFailed();
    };
    socket.onerror = () => {
      /* close event follows; handled there */
    };

    startHeartbeat(socket);
  };

  const startHeartbeat = (socket: WebSocket) => {
    lastFrameAt = Date.now();
    heartbeatTimer = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ t: 'ping', ts: Date.now() }));
      }
    }, HEARTBEAT_INTERVAL_MS);
    watchdogTimer = setInterval(() => {
      if (Date.now() - lastFrameAt > HEARTBEAT_STALE_MS && socket.readyState <= WebSocket.OPEN) {
        teardownSocket(); // zombie socket — force-close fires onclose → reconnect
        onHandshakeFailed();
      }
    }, HEARTBEAT_INTERVAL_MS);
  };

  const onHandshakeFailed = () => {
    if (stopped) return;
    wsAttempts += 1;
    lastSeq = null; // a fresh handshake must not trust stale sequencing
    if (wsAttempts >= MAX_WS_ATTEMPTS && !everLive()) {
      startPolling(); // WS seems unavailable here — degrade gracefully
      return;
    }
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (wsAttempts - 1));
    scheduleReconnect(delay + Math.random() * BACKOFF_JITTER_MS);
  };

  const scheduleReconnect = (delayMs: number) => {
    if (reconnectTimer !== undefined || stopped) return;
    setConnState((s) => (s === 'polling' ? 'polling' : 'reconnecting'));
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      void connect();
    }, delayMs);
  };

  /** Seq-gap repair: drop everything and re-handshake (fresh ticket + socket). */
  const resync = () => {
    teardownSocket();
    lastSeq = null;
    wsAttempts = Math.max(0, wsAttempts - 1); // this isn't an availability failure
    scheduleReconnect(0);
  };

  const terminate = (kind: TerminalEvent['kind'] | null, reason: string) => {
    stopped = true;
    teardownSocket();
    stopPolling();
    if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
    if (countdownTimer !== undefined) clearInterval(countdownTimer);
    setConnState('closed');
    if (kind !== null) opts.onTerminal?.({ kind, reason });
  };

  // ── Public surface ─────────────────────────────────────────────────────────

  void connect();

  return {
    snapshot,
    connState,
    countdownSeconds,
    everLive,
    stop: () => terminate(null, 'client stopped'), // local stop is not a server terminal event
  };
}
