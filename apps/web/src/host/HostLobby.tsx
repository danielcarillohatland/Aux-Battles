/**
 * AUX BATTLES — Host Lobby (the "door", frontend-spec §2.2).
 * Giant code + QR to join + live player count. Realtime via a single WS
 * connection (host/ws.ts, D-D); REST polling is the fallback when WS can't
 * be established. Failures never dead-end: last-known roster stays up under
 * an amber retry banner. Zero animation delays (owner condition #10).
 *
 * Host controls are thin authenticated REST calls. Catalog playback uses the
 * listener-authorized Apple Music service plus optional rights-verified files.
 */
import { createSignal, createEffect, onCleanup, onMount, For, Show } from 'solid-js';
import QRCode from 'qrcode';
import type { Snapshot } from '@aux/shared';
import { apiRequest, HostApiError } from './api.js';
import { buildJoinUrl, resolveJoinOrigin, embedSafeHostUrl, isIpAddressHost } from './join-url.js';
import { errorText } from './errors.js';
import { createHostRealtime } from './ws.js';
import { mascotMood, mascotTalkKey } from './mascot-state.js';
import { relayBase } from './youtube-player.js';
import { StageHud } from './StageHud.js';
import { JudgeStatus } from './JudgeStatus.js';
import { RoundFlow } from './round/RoundFlow.js';
import { Reveal } from './Reveal.js';
import type { RevealEntry } from './Reveal.js';
import {
  disableGameMusic,
  enableGameMusic,
  isGameMusicEnabled,
  musicSceneForState,
  setGameMusicScene,
} from './game-music.js';

interface HostLobbyProps {
  room: { code: string; hostToken: string; playerId: string };
  initialTicket?: string | undefined;
  onPlayAgain: () => Promise<void>;
  onSessionInvalid: () => void;
}

/** Server-side host-control endpoint for this room (game-runtimes route). */
const hostActionUrl = (code: string, action: string) =>
  `/api/v1/rooms/${encodeURIComponent(code)}/host/${action}`;

export const HostLobby = (props: HostLobbyProps) => {
  const [fatal, setFatal] = createSignal<string | null>(null);
  const [actionBusy, setActionBusy] = createSignal(false);
  const [actionError, setActionError] = createSignal<string | null>(null);
  const [appleMusicAvailable, setAppleMusicAvailable] = createSignal(false);
  const [licensedTrackCount, setLicensedTrackCount] = createSignal(0);
  const [deezerAvailable, setDeezerAvailable] = createSignal(false);
  const [youtubeAvailable, setYoutubeAvailable] = createSignal(false);
  const [youtubeReason, setYoutubeReason] = createSignal<string | null>(null);
  const [fullscreen, setFullscreen] = createSignal(document.fullscreenElement !== null);
  const [copyStatus, setCopyStatus] = createSignal('Tap to copy');
  const [musicEnabled, setMusicEnabled] = createSignal(isGameMusicEnabled());
  let canvasRef: HTMLCanvasElement | undefined;
  const refreshMusicStatus = async () => {
    const headers = { authorization: `Bearer ${props.room.hostToken}` };
    await Promise.all([
      apiRequest<{ available: boolean }>(
        `/api/v1/rooms/${encodeURIComponent(props.room.code)}/apple-music/config`,
        { headers },
      )
        .then((status) => setAppleMusicAvailable(status.available))
        .catch(() => setAppleMusicAvailable(false)),
      apiRequest<{ available: boolean; trackCount: number }>(
        `/api/v1/rooms/${encodeURIComponent(props.room.code)}/licensed-music/status`,
        { headers },
      )
        .then((status) => {
          if (status.available) setLicensedTrackCount(status.trackCount);
        })
        .catch(() => {}),
      apiRequest<{ available: boolean }>(
        `/api/v1/rooms/${encodeURIComponent(props.room.code)}/deezer/status`,
        { headers },
      )
        .then((status) => setDeezerAvailable(status.available))
        .catch(() => setDeezerAvailable(false)),
      apiRequest<{ available: boolean; reason?: string }>(
        `/api/v1/rooms/${encodeURIComponent(props.room.code)}/youtube/status`,
        { headers },
      )
        .then((status) => {
          setYoutubeAvailable(status.available);
          setYoutubeReason(status.available ? null : (status.reason ?? null));
        })
        .catch(() => setYoutubeAvailable(false)),
    ]);
  };

  // Create this synchronously so the first render subscribes to its Solid
  // signals. Assigning a plain `let rt` in onMount leaves the initial render
  // permanently subscribed to nothing ("connecting", empty roster).
  const rt = createHostRealtime({
    code: props.room.code,
    hostToken: props.room.hostToken,
    initialTicket: props.initialTicket,
    onRoomGone: props.onSessionInvalid,
    onTerminal: (ev) => {
      if (ev.kind === 'room_closed') props.onSessionInvalid();
      else setFatal('You were removed from the room.');
    },
    onFatal: props.onSessionInvalid,
  });
  onMount(() => {
    void refreshMusicStatus();
    const syncFullscreen = () => setFullscreen(document.fullscreenElement !== null);
    const onPresentKey = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        event.repeat ||
        event.key.toLowerCase() !== 'f' ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        (target instanceof HTMLElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
      ) {
        return;
      }
      event.preventDefault();
      void toggleFullscreen();
    };
    document.addEventListener('fullscreenchange', syncFullscreen);
    window.addEventListener('keydown', onPresentKey);
    onCleanup(() => {
      document.removeEventListener('fullscreenchange', syncFullscreen);
      window.removeEventListener('keydown', onPresentKey);
    });
  });
  onCleanup(() => {
    rt.stop();
    setGameMusicScene('silent');
  });

  const snapshot = () => rt.snapshot();
  const players = () => snapshot()?.players ?? [];
  const state = (): Snapshot['state'] => snapshot()?.state ?? 'LOBBY';
  const countdown = () => rt.countdownSeconds();
  const connState = () => rt.connState();
  const connectionIssue = () => rt.connectionIssue();
  const picksIn = () => Math.max(snapshot()?.submissionsCount ?? 0, rt.submissionCount() ?? 0);

  const degraded = () => connState() === 'reconnecting' || connState() === 'polling';

  createEffect(() => setGameMusicScene(musicSceneForState(state())));

  const toggleMusic = () => {
    if (musicEnabled()) disableGameMusic();
    else enableGameMusic();
    setMusicEnabled(isGameMusicEnabled());
  };

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement !== null) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      setActionError('Fullscreen is unavailable in this browser.');
    }
  };

  const playAgain = async () => {
    if (actionBusy()) return;
    setActionBusy(true);
    setActionError(null);
    try {
      await props.onPlayAgain();
    } catch (err) {
      setActionError(err instanceof HostApiError ? errorText(err.code) : 'Could not create room.');
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

  // LAN QR fix (TDD §1): phones resolve 127.0.0.1/localhost as themselves, so
  // the join URL must use a LAN-reachable origin. On loopback the host types
  // it once (persisted); on a LAN IP or deployed domain it's automatic.
  const [joinOriginOverride, setJoinOriginOverride] = createSignal(
    localStorage.getItem('aux:joinOrigin') ?? '',
  );
  const resolvedJoinOrigin = () => resolveJoinOrigin(joinOriginOverride() || null) ?? '';
  const joinUrl = () => buildJoinUrl(props.room.code, resolvedJoinOrigin() || undefined);
  const [joinOriginDraft, setJoinOriginDraft] = createSignal(joinOriginOverride());
  const [joinOriginError, setJoinOriginError] = createSignal<string | null>(null);
  const saveJoinOrigin = () => {
    const clean = joinOriginDraft().trim();
    if (clean === '') {
      setJoinOriginOverride('');
      localStorage.removeItem('aux:joinOrigin');
      setJoinOriginError(null);
      return;
    }
    try {
      const url = new URL(clean);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        throw new Error('Invalid origin');
      }
      setJoinOriginOverride(url.origin);
      setJoinOriginDraft(url.origin);
      localStorage.setItem('aux:joinOrigin', url.origin);
      setJoinOriginError(null);
    } catch {
      setJoinOriginError('Enter a full address starting with http:// or https://.');
    }
  };

  /** Snapshot results → reveal entries (owner → nickname, bullets included). */
  const revealEntries = (): RevealEntry[] =>
    (snapshot()?.results ?? []).map((r) => ({
      rank: r.rank,
      score: r.score,
      title: r.track.title,
      artist: r.track.artist,
      explanation: r.explanation,
      nickname: r.owner,
      chicken: r.chicken,
      ...(r.reasons !== undefined ? { reasons: r.reasons } : {}),
      ...(r.defenseNote !== undefined ? { defenseNote: r.defenseNote } : {}),
      ...(r.verdict !== undefined ? { verdict: r.verdict } : {}),
      ...(r.judgeModel !== undefined ? { judgeModel: r.judgeModel } : {}),
      ...(r.defense !== undefined ? { defense: r.defense } : {}),
    }));

  const startGame = () => postHostAction('start_game');
  const pickCategory = (category: string) => postHostAction('pick_category', { category });
  const beginPlayback = () => postHostAction('begin_playback');

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
    const url = joinUrl();
    const canvas = canvasRef;
    if (!canvas) return;
    void QRCode.toCanvas(canvas, url, {
      width: 512,
      margin: 1,
      color: { dark: '#10131f', light: '#f6f3e9' },
    });
  });

  const copyCode = async () => {
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(props.room.code);
      setCopyStatus('Code copied');
    } catch {
      setCopyStatus('Select the code to copy');
    }
  };
  const relayHostIsIp = () => isIpAddressHost(new URL(relayBase()).hostname);

  return (
    <main class="stage" data-game-state={state()}>
      <Show
        when={!fatal()}
        fallback={
          <div class="notice notice--bad" role="alert">
            <span>{fatal()}</span>
            <a class="btn btn--small" href="/host.html">
              New room
            </a>
          </div>
        }
      >
        <StageHud
          state={state()}
          roundNumber={(snapshot()?.roundIdx ?? 0) + 1}
          playerCount={players().length}
          submissions={picksIn()}
          countdownSeconds={countdown()}
          connection={connState()}
          fullscreen={fullscreen()}
          musicEnabled={musicEnabled()}
          mood={mascotMood(snapshot())}
          talkKey={mascotTalkKey(snapshot())}
          onToggleFullscreen={() => void toggleFullscreen()}
          onToggleMusic={toggleMusic}
          onNewRoom={props.onSessionInvalid}
        />

        {/* Connection health: amber while reconnecting or on the polling fallback. */}
        <Show when={degraded()}>
          <div class="notice" role="status">
            <span>
              {connState() === 'polling'
                ? 'Realtime unavailable — using backup connection'
                : 'Reconnecting…'}
              <Show when={import.meta.env.DEV && connectionIssue()}>
                {(detail) => <> · {detail()}</>}
              </Show>
            </span>
            <button type="button" class="btn btn--small" onClick={props.onSessionInvalid}>
              New room
            </button>
          </div>
        </Show>

        <Show when={state() === 'LOBBY'}>
          <section class="door rise" aria-labelledby="lobby-title">
            <header class="lobby-heading">
              <h1 class="display" id="lobby-title">
                Who’s on the aux?
              </h1>
            </header>
            <div class="ticket">
              <span class="kicker">Room code</span>
              <button
                type="button"
                class="ticket-code"
                onClick={() => void copyCode()}
                title="Copy room code"
                aria-label={`Copy room code ${props.room.code}`}
              >
                {props.room.code}
              </button>
              <span class="ticket-copy" role="status">
                {copyStatus()}
              </span>
              <span class="ticket-hint">Scan with your phone to join</span>
              <div
                class="qr-panel"
                classList={{ 'qr-panel--unavailable': resolvedJoinOrigin() === '' }}
              >
                <canvas ref={canvasRef} role="img" aria-label={`QR code joining ${joinUrl()}`} />
              </div>
              <Show when={resolvedJoinOrigin() !== ''}>
                <p class="join-url mono">{joinUrl()}</p>
              </Show>
              <Show when={resolveJoinOrigin(null) === null}>
                <details class="join-origin-hint" open={resolvedJoinOrigin() === ''}>
                  <summary>Phone connection</summary>
                  <p>Playing locally? Enter this computer's Wi-Fi address so phones can join:</p>
                  <input
                    class="field"
                    placeholder="e.g. http://192.168.0.122:5173"
                    value={joinOriginDraft()}
                    onInput={(e) => setJoinOriginDraft(e.currentTarget.value)}
                    aria-label="Address for players to join"
                    aria-invalid={joinOriginError() !== null}
                  />
                  <Show when={joinOriginError()}>
                    <p role="alert">{joinOriginError()}</p>
                  </Show>
                  <button
                    type="button"
                    class="btn btn--small btn--primary"
                    onClick={saveJoinOrigin}
                  >
                    Save address
                  </button>
                </details>
              </Show>
            </div>

            <section class="roster" aria-live="polite">
              <div class="roster-heading">
                <h2>The lineup</h2>
                <span class="roster-count">
                  {players().length} {players().length === 1 ? 'player' : 'players'}
                </span>
              </div>
              <Show
                when={players().length > 0}
                fallback={
                  <div class="roster-empty">
                    <span class="roster-empty-icon" aria-hidden="true">
                      ＋
                    </span>
                    <p>Waiting for players</p>
                  </div>
                }
              >
                <ul class="roster-list">
                  <For each={players()}>
                    {(p) => (
                      <li class="roster-chip pop" classList={{ 'is-offline': !p.connected }}>
                        <i aria-hidden="true" />
                        {p.nickname}
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </section>

            <div class="lobby-setup">
              <JudgeStatus code={props.room.code} hostToken={props.room.hostToken} />
              <details class="playback-setup">
                <summary>Playback options</summary>
                <div class="setlist" aria-label="Music setup">
                  <Show
                    when={youtubeAvailable()}
                    fallback={
                      <span class="tag tag--warn" title={youtubeReason() ?? undefined}>
                        Video playback unavailable
                      </span>
                    }
                  >
                    <span class="tag tag--good">YouTube videos ready</span>
                  </Show>
                  <Show when={youtubeAvailable() && relayHostIsIp()}>
                    <a class="tag tag--warn" href={embedSafeHostUrl(window.location)}>
                      Open at {embedSafeHostUrl(window.location)} to play video
                    </a>
                  </Show>
                  <Show when={deezerAvailable()}>
                    <span class="tag">Deezer previews</span>
                  </Show>
                  <Show when={appleMusicAvailable()}>
                    <span class="tag">Apple Music</span>
                  </Show>
                  <Show when={licensedTrackCount() > 0}>
                    <span class="tag">Licensed · {licensedTrackCount()}</span>
                  </Show>
                </div>
              </details>
            </div>

            <div class="stage-cta lobby-cta">
              <p class="lobby-ready">
                {players().length === 0 ? 'Share the code to get started.' : 'Everyone in?'}
              </p>
              <button
                type="button"
                class="btn btn--primary btn--big btn--block"
                disabled={players().length === 0 || actionBusy()}
                onClick={() => void startGame()}
              >
                {actionBusy() ? 'Starting…' : 'Start game'}
              </button>
            </div>
          </section>
        </Show>

        <Show when={actionError()}>
          <div class="notice notice--bad" role="alert">
            <span>{actionError()}</span>
          </div>
        </Show>

        {/* RESULTS owns its full-screen choreography (host/Reveal.tsx, TDD §9). */}
        <Show when={state() === 'RESULTS'}>
          <Reveal
            results={revealEntries()}
            totalCount={snapshot()?.resultCount}
            busy={actionBusy()}
            onAdvance={(final) => void postHostAction('advance_reveal', { final })}
          />
        </Show>

        <Show when={inRoundFlow() && state() !== 'RESULTS' && snapshot()}>
          {(snap) => (
            <RoundFlow
              snapshot={snap()}
              submissionsCount={picksIn()}
              countdownSeconds={countdown()}
              scenario={snap().scenario ?? ''}
              busy={actionBusy()}
              queue={snap().queue ?? []}
              playbackIndex={snap().playbackIndex ?? 0}
              hostToken={props.room.hostToken}
              onPickCategory={(c) => void pickCategory(c)}
              onBeginPlayback={() => void beginPlayback()}
              onManualAdvance={() => void advanceManual()}
              onNextJudgement={() => void postHostAction('next_judgement')}
              onCloseVote={() => void postHostAction('close_vote')}
              onAdvanceReveal={(final) => void postHostAction('advance_reveal', { final })}
              onNextRound={() => void postHostAction('next_round')}
              onFinish={() => void postHostAction('finish_game')}
              onPlayAgain={() => void playAgain()}
            />
          )}
        </Show>
      </Show>
    </main>
  );
};
