/**
 * AUX BATTLES — player realtime client (TDD §9 + D-D).
 *
 * Same wire model as the host client: one WebSocket per client, connect-ticket
 * flow (`POST /api/v1/ws-ticket` with Bearer playerToken → `{ok,data:{ticket}}`
 * → `/ws?room=&ticket=`), 15 s ping heartbeat, exponential-backoff reconnect,
 * seq-gap detection repaired by a fresh handshake (no `resync` frame — D-D),
 * local countdown from absolute `phaseEndsAt`, replace-never-merge snapshots.
 *
 * Player-specific: phones drop sockets constantly (lock screen, elevator),
 * so the watchdog is aggressive and the REST polling fallback is the safety
 * net that keeps the waiting screen truthful when WS can't be established.
 */
import { createSignal } from 'solid-js';
import { HEARTBEAT_INTERVAL_MS, ServerFrameSchema, SnapshotSchema } from '@aux/shared';
import type { ServerFrame, Snapshot } from '@aux/shared';

const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 8_000;
const BACKOFF_JITTER_MS = 250;
/** Silence longer than this ⇒ dead socket (phones especially). */
const HEARTBEAT_STALE_MS = HEARTBEAT_INTERVAL_MS * 2 + 5_000;
const MAX_WS_ATTEMPTS = 3;
const WS_RETRY_WHILE_POLLING_MS = 30_000;
const POLL_INTERVAL_MS = 3_000;

export type ConnState = 'connecting' | 'live' | 'reconnecting' | 'polling' | 'closed';

export type TerminalEvent = { kind: 'room_closed' | 'kicked'; reason: string };

export interface RealtimeHandle {
  readonly snapshot: () => Snapshot | null;
  readonly connState: () => ConnState;
  /** Seconds left in the phase, computed locally from `phaseEndsAt` (D-C). */
  readonly countdownSeconds: () => number | null;
  stop: () => void;
}

interface RealtimeOptions {
  code: string;
  playerToken: string;
  /** Room vanished (expired/closed) while polling — UI sends them back to join. */
  onRoomGone?: () => void;
  onTerminal?: (event: TerminalEvent) => void;
}

export function createPlayerRealtime(opts: RealtimeOptions): RealtimeHandle {
  const [snapshot, setSnapshot] = createSignal<Snapshot | null>(null);
  const [connState, setConnState] = createSignal<ConnState>('connecting');
  const [countdownSeconds, setCountdownSeconds] = createSignal<number | null>(null);

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

  // ── Countdown (D-C: server owns the deadline; we render it) ────────────────

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

  // ── Polling fallback ───────────────────────────────────────────────────────

  const pollSnapshot = async () => {
    let res: Response;
    try {
      res = await fetch(`/api/v1/rooms/${encodeURIComponent(opts.code)}/snapshot`, {
        headers: { accept: 'application/json' },
      });
    } catch {
      return; // transient; next tick retries
    }
    if (stopped) return;
    if (res.status === 404) {
      opts.onRoomGone?.();
      return;
    }
    if (!res.ok) return;
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return;
    }
    const data =
      (body as { ok?: boolean; data?: unknown }).ok === true
        ? (body as { data: unknown }).data
        : null;
    if (data === null) return;
    const parsed = SnapshotSchema.safeParse(data);
    if (parsed.success) applySnapshot(parsed.data);
  };

  const startPolling = () => {
    if (pollTimer !== undefined || stopped) return;
    setConnState('polling');
    void pollSnapshot();
    pollTimer = setInterval(() => void pollSnapshot(), POLL_INTERVAL_MS);
    scheduleReconnect(WS_RETRY_WHILE_POLLING_MS); // keep probing for WS
  };

  const stopPolling = () => {
    if (pollTimer !== undefined) {
      clearInterval(pollTimer);
      pollTimer = undefined;
    }
  };

  // ── Frames (replace-never-merge) ───────────────────────────────────────────

  const applySnapshot = (snap: Snapshot) => {
    setSnapshot(snap);
    startCountdown();
  };

  const handleFrame = (raw: unknown) => {
    lastFrameAt = Date.now();
    if (!ServerFrameSchema.safeParse(raw).success) return;
    const frame = raw as ServerFrame;

    switch (frame.t) {
      case 'state_change': {
        // Seq-gap repair (D-D): fresh handshake's first state_change resyncs.
        if (lastSeq !== null && frame.seq > lastSeq + 1) {
          resync();
          return;
        }
        lastSeq = frame.seq;
        applySnapshot(frame.snapshot);
        return;
      }
      case 'timer_tick':
        return; // ignored — countdown derives from phaseEndsAt (D-C)
      case 'submission_received':
        return; // count arrives authoritatively via state_change
      case 'judgement':
      case 'reveal_owner':
        return; // Phase 4 payloads land later
      case 'playback_cue':
        return; // host-only; never expected on a player socket
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

  const fetchTicket = async (): Promise<string | null> => {
    try {
      const res = await fetch('/api/v1/ws-ticket', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${opts.playerToken}`,
        },
        body: JSON.stringify({ code: opts.code }),
      });
      if (!res.ok || res.status === 404) return null; // endpoint not deployed yet → fallback
      const body = (await res.json()) as { ok?: boolean; data?: { ticket?: unknown } };
      const ticket = body.ok === true ? body.data?.ticket : undefined;
      return typeof ticket === 'string' && ticket.length > 0 ? ticket : null;
    } catch {
      return null;
    }
  };

  const connect = async () => {
    if (stopped) return;
    teardownSocket();
    setConnState('connecting');

    const ticket = await fetchTicket();
    if (ticket === null) return onHandshakeFailed();
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
      if (connState() !== 'live') {
        wsAttempts = 0;
        stopPolling(); // WS recovered — polling stands down
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
      /* close follows */
    };

    // Heartbeat + zombie-socket watchdog.
    lastFrameAt = Date.now();
    heartbeatTimer = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ t: 'ping', ts: Date.now() }));
      }
    }, HEARTBEAT_INTERVAL_MS);
    watchdogTimer = setInterval(() => {
      if (Date.now() - lastFrameAt > HEARTBEAT_STALE_MS && socket.readyState <= WebSocket.OPEN) {
        teardownSocket();
        onHandshakeFailed();
      }
    }, HEARTBEAT_INTERVAL_MS);
  };

  const onHandshakeFailed = () => {
    if (stopped) return;
    wsAttempts += 1;
    lastSeq = null;
    if (wsAttempts >= MAX_WS_ATTEMPTS && connState() !== 'live') {
      startPolling();
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

  const resync = () => {
    teardownSocket();
    lastSeq = null;
    wsAttempts = Math.max(0, wsAttempts - 1);
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

  void connect();

  return {
    snapshot,
    connState,
    countdownSeconds,
    stop: () => terminate(null, 'client stopped'),
  };
}
