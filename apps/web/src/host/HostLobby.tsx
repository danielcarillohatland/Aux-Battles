/**
 * AUX BATTLES — Host Lobby (the "door", frontend-spec §2.2).
 * Giant code + QR to join + live player count. Realtime via a single WS
 * connection (host/ws.ts, D-D); REST polling is the fallback when WS can't
 * be established. Failures never dead-end: last-known roster stays up under
 * an amber retry banner. Zero animation delays (owner condition #10).
 *
 * Host controls are thin authenticated REST calls; Spotify authorization is
 * room-bound and optional, so manual playback remains a complete fallback.
 */
import { createSignal, createEffect, onCleanup, onMount, For, Show } from 'solid-js';
import QRCode from 'qrcode';
import type { Snapshot } from '@aux/shared';
import { apiRequest, HostApiError } from './api.js';
import { errorText } from './errors.js';
import { createHostRealtime } from './ws.js';
import { RoundFlow } from './round/RoundFlow.js';

interface HostLobbyProps {
  room: { code: string; hostToken: string; playerId: string };
}

/** Server-side host-control endpoint for this room (game-runtimes route). */
const hostActionUrl = (code: string, action: string) =>
  `/api/v1/rooms/${encodeURIComponent(code)}/host/${action}`;

/** Friendly label per FSM state — shown next to the connection dot. */
const STATE_LABEL: Record<Snapshot['state'], string> = {
  LOBBY: 'lobby',
  CATEGORY: 'picking a category',
  SCENARIO: 'scenario reveal',
  SONG_SELECTION: 'song picking',
  LOCKED: 'answers locked',
  PLAYBACK: 'playback',
  AI_JUDGING: 'the judge deliberates',
  RESULTS: 'results',
  LEADERBOARD: 'leaderboard',
  GAME_OVER: 'game over',
};

export const HostLobby = (props: HostLobbyProps) => {
  const [fatal, setFatal] = createSignal<string | null>(null);
  const [actionBusy, setActionBusy] = createSignal(false);
  const [actionError, setActionError] = createSignal<string | null>(null);
  const [spotifyAvailable, setSpotifyAvailable] = createSignal(false);
  const [spotifyConnected, setSpotifyConnected] = createSignal(false);
  let canvasRef: HTMLCanvasElement | undefined;

  // Realtime engine: WS-first with built-in polling fallback + reconnect.
  let rt!: ReturnType<typeof createHostRealtime>;
  onMount(() => {
    rt = createHostRealtime({
      code: props.room.code,
      hostToken: props.room.hostToken,
      onRoomGone: () => setFatal(errorText('ROOM_NOT_FOUND')),
      onTerminal: (ev) =>
        setFatal(
          ev.kind === 'kicked' ? 'You were removed from the room.' : errorText('ROOM_CLOSED'),
        ),
    });
    void apiRequest<{ connected: boolean }>(
      `/api/v1/rooms/${encodeURIComponent(props.room.code)}/spotify/status`,
      { headers: { authorization: `Bearer ${props.room.hostToken}` } },
    )
      .then(({ connected }) => {
        setSpotifyAvailable(true);
        setSpotifyConnected(connected);
      })
      .catch(() => {
        // Spotify credentials are optional; an unregistered route means the
        // fully functional manual-playback experience should stay uncluttered.
      });
  });
  onCleanup(() => rt?.stop());

  const snapshot = () => rt?.snapshot() ?? null;
  const players = () => snapshot()?.players ?? [];
  const state = (): Snapshot['state'] => snapshot()?.state ?? 'LOBBY';
  const countdown = () => rt?.countdownSeconds() ?? null;
  const connState = () => rt?.connState() ?? 'connecting';

  const degraded = () => connState() === 'reconnecting' || connState() === 'polling';

  const connectSpotify = async () => {
    if (actionBusy() || spotifyConnected()) return;
    setActionBusy(true);
    setActionError(null);
    try {
      const { authorizeUrl } = await apiRequest<{ authorizeUrl: string }>(
        `/api/v1/rooms/${encodeURIComponent(props.room.code)}/spotify/login`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${props.room.hostToken}` },
          body: JSON.stringify({}),
        },
      );
      location.assign(authorizeUrl);
    } catch (err) {
      setActionError(
        err instanceof HostApiError ? errorText(err.code) : 'Could not connect Spotify.',
      );
      setActionBusy(false);
    }
  };

  const advanceManual = async () => {
    if (actionBusy()) return;
    setActionBusy(true);
    setActionError(null);
    try {
      await apiRequest(hostActionUrl(props.room.code, 'manual_next'), {
        method: 'POST',
        headers: { authorization: `Bearer ${props.room.hostToken}` },
        body: JSON.stringify({}),
      });
    } catch (err) {
      setActionError(err instanceof HostApiError ? errorText(err.code) : 'Something went wrong.');
    } finally {
      setActionBusy(false);
    }
  };

  /** FSM states owned by the round-flow screens (everything else stays lobby). */
  const ROUND_STATES: ReadonlySet<Snapshot['state']> = new Set([
    'CATEGORY',
    'SCENARIO',
    'SONG_SELECTION',
    'LOCKED',
    'PLAYBACK',
    'AI_JUDGING',
    'RESULTS',
    'LEADERBOARD',
    'GAME_OVER',
  ]);
  const inRoundFlow = () => ROUND_STATES.has(state());

  const joinUrl = `${location.origin}/player.html?code=${props.room.code}`;

  /** LOBBY → CATEGORY (POST /host/start-game). */
  const startGame = async () => {
    if (actionBusy()) return;
    setActionBusy(true);
    setActionError(null);
    try {
      await apiRequest(hostActionUrl(props.room.code, 'start_game'), {
        method: 'POST',
        headers: { authorization: `Bearer ${props.room.hostToken}` },
        body: JSON.stringify({}),
      });
    } catch (err) {
      setActionError(err instanceof HostApiError ? errorText(err.code) : 'Something went wrong.');
    } finally {
      setActionBusy(false);
    }
  };

  /** CATEGORY → SCENARIO (POST /rooms/:code/host/pick_category). */
  const [scenario, setScenario] = createSignal('');
  const pickCategory = async (chosen: string) => {
    if (!chosen || actionBusy()) return;
    setActionBusy(true);
    setActionError(null);
    try {
      await apiRequest(hostActionUrl(props.room.code, 'pick_category'), {
        method: 'POST',
        headers: { authorization: `Bearer ${props.room.hostToken}` },
        body: JSON.stringify({ category: chosen }),
      });
      setScenario(chosen); // host-local mirror until snapshots carry the category
    } catch (err) {
      setActionError(err instanceof HostApiError ? errorText(err.code) : 'Something went wrong.');
    } finally {
      setActionBusy(false);
    }
  };

  /** LOCKED → PLAYBACK (POST /rooms/:code/host/begin_playback). */
  const beginPlayback = async () => {
    if (actionBusy()) return;
    setActionBusy(true);
    setActionError(null);
    try {
      await apiRequest(hostActionUrl(props.room.code, 'begin_playback'), {
        method: 'POST',
        headers: { authorization: `Bearer ${props.room.hostToken}` },
        body: JSON.stringify({}),
      });
    } catch (err) {
      setActionError(err instanceof HostApiError ? errorText(err.code) : 'Something went wrong.');
    } finally {
      setActionBusy(false);
    }
  };

  const postHostAction = async (action: string, body: Record<string, unknown> = {}) => {
    if (actionBusy()) return;
    setActionBusy(true);
    setActionError(null);
    try {
      await apiRequest(hostActionUrl(props.room.code, action), {
        method: 'POST',
        headers: { authorization: `Bearer ${props.room.hostToken}` },
        body: JSON.stringify(body),
      });
    } catch (err) {
      setActionError(err instanceof HostApiError ? errorText(err.code) : 'Something went wrong.');
    } finally {
      setActionBusy(false);
    }
  };

  // Render QR once the canvas exists; re-render only if the URL changes.
  createEffect(() => {
    const canvas = canvasRef;
    if (!canvas) return;
    void QRCode.toCanvas(canvas, joinUrl, {
      width: Math.min(420, Math.floor(window.innerHeight * 0.5)),
      margin: 1,
      color: { dark: '#0e0b16', light: '#ffffff' },
    });
  });

  return (
    <main class="stage lobby">
      <Show
        when={!fatal()}
        fallback={
          <div class="banner banner-error" role="alert">
            <span>{fatal()}</span>
            <a class="btn-retry" href="/host.html">
              New room
            </a>
          </div>
        }
      >
        <p class="lobby-label">ROOM CODE</p>
        <div
          class="room-code"
          title="Tap to copy"
          onClick={() => void navigator.clipboard?.writeText(props.room.code)}
        >
          {props.room.code}
        </div>

        <div class="qr-panel">
          <canvas ref={canvasRef} aria-label={`QR code joining ${joinUrl}`} />
          <p class="join-url">{joinUrl}</p>
        </div>

        <Show when={spotifyAvailable()}>
          <button
            type="button"
            class="btn-secondary spotify-connect"
            disabled={actionBusy() || spotifyConnected()}
            onClick={() => void connectSpotify()}
          >
            {spotifyConnected() ? 'Spotify connected ✓' : 'Connect Spotify'}
          </button>
        </Show>

        {/* Connection health: amber while reconnecting or on the polling fallback. */}
        <div class="banner banner-warn" role="status" hidden={!degraded()}>
          <span>
            {connState() === 'polling'
              ? 'Realtime unavailable — polling instead 🐢'
              : 'Reconnecting…'}
          </span>
        </div>
        <p class="lobby-label" data-state={state()}>
          phase: {STATE_LABEL[state()]}
          <Show when={countdown() !== null}> · {countdown()}s left</Show> ·{' '}
          {connState() === 'live' ? '🟢 live' : '🟡 ' + connState()}
        </p>

        <section class="roster">
          <h2>players joined: {players().length}</h2>
          <Show
            when={players().length > 0}
            fallback={<p class="empty-roster">Nobody yet — share the QR! ↖</p>}
          >
            <ul>
              <For each={players()}>
                {(p) => (
                  <li classList={{ ghost: !p.connected }}>
                    {p.nickname}
                    <Show when={!p.connected}> 👻</Show>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </section>

        <Show when={actionError()}>
          <div class="banner banner-error" role="alert">
            <span>{actionError()}</span>
          </div>
        </Show>

        {/* Phase-3 round flow: the step screen per FSM state. */}
        <Show
          when={inRoundFlow()}
          fallback={
            <button
              type="button"
              class="btn-primary btn-start"
              disabled={players().length === 0 || actionBusy() || inRoundFlow()}
              onClick={() => void startGame()}
            >
              {actionBusy() ? 'Starting…' : 'Start Game ▶'}
            </button>
          }
        >
          <Show when={snapshot()}>
            {(snap) => (
              <RoundFlow
                snapshot={snap()}
                countdownSeconds={countdown()}
                scenario={snap().scenario ?? scenario()}
                busy={actionBusy()}
                queue={snap().queue ?? []}
                playbackIndex={snap().playbackIndex ?? 0}
                onPickCategory={(c) => void pickCategory(c)}
                onBeginPlayback={() => void beginPlayback()}
                onManualAdvance={() => void advanceManual()}
                onAdvanceReveal={(final) => void postHostAction('advance_reveal', { final })}
                onNextRound={() => void postHostAction('next_round')}
                onFinish={() => void postHostAction('finish_game')}
              />
            )}
          </Show>
        </Show>
      </Show>
    </main>
  );
};
