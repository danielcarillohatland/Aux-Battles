/**
 * Player app — phone join flow + waiting screen (TDD §9, frontend-spec §2.3).
 * Single screen, two fields, sticky CTA above the keyboard. Fewer clicks per owner philosophy.
 */
import { createEffect, createSignal, onCleanup, onMount, Show } from 'solid-js';
import { render } from 'solid-js/web';
import { NICKNAME_MAX, NicknameSchema, RoomCodeSchema } from '@aux/shared';
import type { Snapshot } from '@aux/shared';
import '../shared-ui/shell.css';
import './player.css';
import { joinRoom, fetchRoomJudgeMode } from './api.js';
import type { JoinFailure } from './api.js';
import { clearSession, loadSession, readUrlCode, saveSession } from './session.js';
import { AppInfo, type AppInfoReportContext } from '../shared-ui/AppInfo.js';
import { VibeLine } from '../shared-ui/vibe-line.js';
import type { PlayerSession } from './session.js';
import { createPlayerRealtime } from './ws.js';
import { clearSubmissionIfStale, loadSubmission } from './submission-store.js';
import type { SubmissionRecord } from './submission-store.js';
import { SongSelection } from './SongSelection.js';
import { SealedScreen } from './SealedScreen.js';
import { PlayerPostRound } from './PostRound.js';
import { CrowdVote } from './CrowdVote.js';

const PlayerMascot = (props: { mood: Snapshot['state'] | 'JOIN'; compact?: boolean }) => (
  <div
    class="p-mascot"
    classList={{ 'p-mascot--compact': props.compact === true }}
    data-mood={props.mood}
    aria-hidden="true"
  >
    <img src="/assets/dj-aux-head.png" alt="" width="512" height="512" draggable={false} />
  </div>
);

// ── Join screen ───────────────────────────────────────────────────────────────

const JoinScreen = (props: { onJoined: (s: PlayerSession) => void }) => {
  const [code, setCode] = createSignal(readUrlCode());
  const [nick, setNick] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [failure, setFailure] = createSignal<JoinFailure | null>(null);
  const [rateLeft, setRateLeft] = createSignal(0);
  const [judgeMode, setJudgeMode] = createSignal<'ai' | 'crowd' | null>(null);
  const [checkingRoom, setCheckingRoom] = createSignal(false);
  const [modeAttempt, setModeAttempt] = createSignal(0);
  const [aiConsent, setAiConsent] = createSignal(false);

  let codeInput: HTMLInputElement | undefined;
  let nickInput: HTMLInputElement | undefined;

  const codeValid = () => RoomCodeSchema.safeParse(code()).success;
  const nickValid = () => NicknameSchema.safeParse(nick()).success;
  const canJoin = () =>
    codeValid() &&
    nickValid() &&
    !busy() &&
    rateLeft() === 0 &&
    !checkingRoom() &&
    judgeMode() !== null &&
    (judgeMode() !== 'ai' || aiConsent());

  createEffect(() => {
    const roomCode = code();
    modeAttempt();
    setJudgeMode(null);
    setAiConsent(false);
    if (!RoomCodeSchema.safeParse(roomCode).success) {
      setCheckingRoom(false);
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    const timeout = setTimeout(() => controller.abort(), 8_000);
    setCheckingRoom(true);
    void fetchRoomJudgeMode(roomCode, controller.signal).then((mode) => {
      clearTimeout(timeout);
      if (cancelled) return;
      setJudgeMode(mode);
      setCheckingRoom(false);
    });
    onCleanup(() => {
      cancelled = true;
      clearTimeout(timeout);
      controller.abort();
    });
  });

  // Rate-limit countdown ticks once a second until it hits zero.
  createEffect(() => {
    if (rateLeft() <= 0) return;
    const t = setInterval(() => setRateLeft((n) => Math.max(0, n - 1)), 1_000);
    onCleanup(() => clearInterval(t));
  });

  onMount(() => {
    // Scanned QR → code prefilled: go straight for the name. Otherwise start at the code.
    if (codeValid()) nickInput?.focus();
    else codeInput?.focus();
  });

  const onCodeInput = (v: string) => {
    setFailure(null);
    setCode(
      v
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '')
        .slice(0, 5),
    );
  };

  const submit = async (e?: SubmitEvent) => {
    e?.preventDefault();
    if (!canJoin()) return;
    setBusy(true);
    setFailure(null);
    const result = await joinRoom(code(), nick().trim(), judgeMode() === 'ai' && aiConsent());
    setBusy(false);
    if (result.ok) {
      navigator.vibrate?.(15); // haptic bump — you made it in
      props.onJoined(result.session);
      return;
    }
    setFailure(result.failure);
    if (result.failure.kind === 'rate_limited') setRateLeft(result.failure.retryAfterS);
    if (result.failure.kind === 'name_taken') nickInput?.select();
  };

  const errorCopy = (): string => {
    switch (failure()?.kind) {
      case 'name_taken':
        return 'name taken';
      case 'room_not_found':
        return 'check the room code';
      case 'rate_limited': {
        const n = rateLeft();
        return n > 0 ? `try again in ${n}s` : 'try again soon';
      }
      case 'other': {
        const f = failure();
        return f && f.kind === 'other' ? f.message : 'try again';
      }
      default:
        return '';
    }
  };

  return (
    <form class="p-screen p-join" onSubmit={submit}>
      <a class="p-brand" href="/host.html" aria-label="AUX Battles home">
        AUX<span>/</span>BATTLES <i aria-hidden="true">↗</i>
      </a>
      <header class="p-hero">
        <div class="p-join-record" aria-hidden="true">
          <span>AUX</span>
        </div>
        <h1 class="display">You’re on.</h1>
      </header>

      <div class="p-form">
        <label class="p-field">
          <span class="kicker">Room code</span>
          <input
            id="p-code"
            ref={codeInput}
            class="field p-code"
            classList={{ 'field--bad': failure()?.kind === 'room_not_found' }}
            value={code()}
            onInput={(e) => onCodeInput(e.currentTarget.value)}
            placeholder="ABCDE"
            maxLength={5}
            autoCapitalize="characters"
            autocomplete="off"
            autocorrect="off"
            spellcheck={false}
            inputMode="text"
            aria-label="Room code"
            aria-invalid={failure()?.kind === 'room_not_found'}
          />
          <Show when={code().length === 5 && !codeValid()}>
            <span class="p-fine">5 letters or numbers</span>
          </Show>
        </label>
        <label class="p-field">
          <span class="kicker">Your name</span>
          <input
            id="p-nick"
            ref={nickInput}
            class="field"
            classList={{ 'field--bad': failure()?.kind === 'name_taken' }}
            value={nick()}
            onInput={(e) => {
              setFailure(null);
              setNick(e.currentTarget.value);
            }}
            placeholder="DJ Bagel"
            maxLength={NICKNAME_MAX}
            autocomplete="nickname"
            enterkeyhint="go"
            aria-label="Your nickname"
            aria-invalid={failure()?.kind === 'name_taken'}
          />
          <Show when={nick().length > 0 && !nickValid()}>
            <span class="p-fine">Keep it short</span>
          </Show>
        </label>
        <Show when={codeValid() && !checkingRoom() && judgeMode() === null}>
          <div class="p-room-check" role="status">
            <span>Check the room code, or try again.</span>
            <button
              type="button"
              class="btn btn--ghost btn--small"
              onClick={() => setModeAttempt((n) => n + 1)}
            >
              Retry
            </button>
          </div>
        </Show>
        <Show when={judgeMode() === 'ai'}>
          <label class="p-ai-consent">
            <input
              type="checkbox"
              checked={aiConsent()}
              onChange={(event) => setAiConsent(event.currentTarget.checked)}
            />
            <span>
              I agree to share my song choices and optional defense with OpenRouter and its AI model
              providers for AI judging. No audio is sent.
            </span>
          </label>
        </Show>
        <Show when={failure()}>
          <p class="p-error" role="alert">
            {errorCopy()}
          </p>
        </Show>
        <AppInfo />
      </div>

      {/* Sticky CTA: never swallowed by the mobile keyboard. */}
      <div class="p-cta-bar">
        <button type="submit" class="btn btn--primary btn--big btn--block" disabled={!canJoin()}>
          <Show when={!busy()} fallback="Joining…">
            {checkingRoom() ? 'Checking room…' : 'Join the room'}
          </Show>
        </button>
      </div>
    </form>
  );
};

// ── Waiting screen ────────────────────────────────────────────────────────────

/** Friendly FSM label shown live from the realtime snapshot. */
const STATE_LABEL: Record<Snapshot['state'], string> = {
  LOBBY: 'Waiting for the host',
  CATEGORY: 'Host is picking a vibe',
  SCENARIO: 'Read the prompt',
  SONG_SELECTION: 'Pick a song',
  LOCKED: 'Picks are locked',
  PLAYBACK: 'Listening party',
  AI_JUDGING: 'The judge is in',
  RESULTS: 'The reveal',
  LEADERBOARD: 'Standings',
  GAME_OVER: 'Game over',
};

const WaitingScreen = (props: { session: PlayerSession; onLost: () => void }) => {
  const [kickCopy, setKickCopy] = createSignal<string | null>(null);

  // Create synchronously so this render subscribes to the realtime signals.
  // A plain handle assigned in onMount is not reactive in Solid.
  const rt = createPlayerRealtime({
    code: props.session.code,
    playerToken: props.session.playerToken,
    onRoomGone: () => {
      clearSession(); // room's gone — dead ends are banned, so send them back to rejoin
      props.onLost();
    },
    onTerminal: (ev) => {
      if (ev.kind === 'room_closed') {
        clearSession();
        props.onLost();
        return;
      }
      // Kicked: stay on screen with copy; the player can rejoin via back nav.
      setKickCopy(`you were removed: ${ev.reason}`);
    },
  });
  onCleanup(() => rt.stop());

  const state = (): Snapshot['state'] => rt.snapshot()?.state ?? 'LOBBY';
  const count = () => rt.snapshot()?.players.length ?? null;
  const scenario = () => rt.snapshot()?.scenario ?? '';
  const countdown = () => rt.countdownSeconds();
  const connState = () => rt.connState();
  const connectionIssue = () => rt.connectionIssue();
  const submitted = () => rt.submissionCount();
  const roundIdx = () => rt.snapshot()?.roundIdx ?? 0;

  // ── Phase-3 routing: song selection → sealed → chicken ─────────────────────
  // Local record of MY pick is the truth-source the snapshot lacks: it can't
  // tell `you.hasSubmitted` (mine) from a server-side CHICKEN assignment.
  const [record, setRecord] = createSignal<SubmissionRecord | null>(
    loadSubmission(props.session.code),
  );

  // Round rolled over → drop last round's record so it can't seal the new round.
  createEffect(() => {
    const r = roundIdx();
    const rec = record();
    if (rec && rec.roundIdx !== r) {
      clearSubmissionIfStale(props.session.code, r);
      setRecord(null);
    }
  });

  const hasSubmitted = () => rt.snapshot()?.you.hasSubmitted === true || record() !== null;
  /** Server says submitted + we have no pick on file ⇒ judge assigned us one. */
  const chicken = () => rt.snapshot()?.you.hasSubmitted === true && record() === null;

  const inSelectionPhase = () => state() === 'SONG_SELECTION';
  const showSealed = () => hasSubmitted() && (inSelectionPhase() || state() === 'LOCKED');
  const showPickUi = () => inSelectionPhase() && !hasSubmitted();

  const onSealed = () => setRecord(loadSubmission(props.session.code));
  /** Only names this viewer can see; defenses only once their owners are revealed. */
  const reportContext = (): AppInfoReportContext => {
    const snap = rt.snapshot();
    return {
      roomCode: props.session.code,
      sessionToken: props.session.playerToken,
      players: (snap?.players ?? [])
        .map((player) => player.nickname)
        .filter((name) => name !== props.session.nickname),
      roundIdx: snap?.roundIdx ?? 0,
      defenseOwners: (snap?.results ?? [])
        .filter((result) => result.defense !== undefined)
        .map((result) => result.owner),
    };
  };

  return (
    <Show
      when={showPickUi()}
      fallback={
        <Show
          when={showSealed()}
          fallback={
            <Show
              when={state() === 'RESULTS' || state() === 'LEADERBOARD' || state() === 'GAME_OVER'}
              fallback={
                <div class="p-screen p-wait" data-state={state()}>
                  <header class="p-top">
                    <span class="kicker">Room {props.session.code}</span>
                    <Show when={countdown() !== null}>
                      <span class="p-timer mono" role="timer">
                        {countdown()}s
                      </span>
                    </Show>
                  </header>
                  <div class="p-wait-body">
                    <Show when={state() !== 'AI_JUDGING' || rt.snapshot()?.judgingMode !== 'crowd'}>
                      <PlayerMascot mood={state()} compact />
                      <p class="kicker">You're in, {props.session.nickname}</p>
                      <h1 class="display p-wait-title">{STATE_LABEL[state()]}</h1>
                      <Show when={state() === 'LOBBY'}>
                        <p class="muted">
                          {count() === null
                            ? 'Connecting…'
                            : `${count()} player${count() === 1 ? '' : 's'} · waiting for the host`}
                        </p>
                      </Show>
                      <Show when={state() === 'SCENARIO' && scenario() !== ''}>
                        <div class="p-prompt pop">
                          <span class="kicker">The prompt</span>
                          <p class="display p-prompt-text">{scenario()}</p>
                          <VibeLine vibe={rt.snapshot()?.scenarioVibe} />
                        </div>
                      </Show>
                      <Show when={state() === 'PLAYBACK' || state() === 'AI_JUDGING'}>
                        <p class="muted">Eyes on the host screen.</p>
                      </Show>
                    </Show>
                    <Show
                      when={
                        state() === 'AI_JUDGING' &&
                        rt.snapshot()?.judgingMode === 'crowd' &&
                        rt.snapshot()
                      }
                    >
                      {(snap) => (
                        <CrowdVote snapshot={snap()} playerToken={props.session.playerToken} />
                      )}
                    </Show>
                    <Show when={connState() !== 'live'}>
                      <p class="p-fine">
                        {connState() === 'polling' ? 'Backup connection' : 'Reconnecting…'}
                      </p>
                    </Show>
                    <Show when={import.meta.env.DEV && connectionIssue()}>
                      {(detail) => (
                        <p class="p-error" role="status">
                          {detail()}
                        </p>
                      )}
                    </Show>
                    <Show when={kickCopy()}>
                      <p class="p-error" role="alert">
                        {kickCopy()}
                      </p>
                    </Show>
                    <AppInfo reportContext={reportContext()} />
                  </div>
                </div>
              }
            >
              <Show when={rt.snapshot()} keyed>
                {(snap) => (
                  <>
                    <PlayerPostRound
                      snapshot={snap}
                      nickname={props.session.nickname}
                      onRematch={() => {
                        // GAME_OVER is FSM-terminal: rematch = fresh room via the
                        // join door. Drop the dead session and start over.
                        clearSession();
                        props.onLost();
                      }}
                    />
                    <AppInfo reportContext={reportContext()} />
                  </>
                )}
              </Show>
            </Show>
          }
        >
          <SealedScreen
            nickname={props.session.nickname}
            track={record()?.track ?? null}
            chicken={chicken()}
            roundIdx={roundIdx()}
            submitted={submitted}
            totalPlayers={count}
            countdownSeconds={countdown}
          />
        </Show>
      }
    >
      <SongSelection
        session={props.session}
        scenario={scenario()}
        vibe={rt.snapshot()?.scenarioVibe ?? null}
        roundIdx={roundIdx()}
        countdownSeconds={countdown}
        onSealed={onSealed}
      />
    </Show>
  );
};

// ── Root ──────────────────────────────────────────────────────────────────────

// Reconnect-on-load: stored session + matching ?code → straight to waiting.
function initialSession(): PlayerSession | null {
  const urlCode = readUrlCode();
  const stored = loadSession();
  return stored && urlCode === stored.code ? stored : null;
}

const App = () => {
  const [session, setSession] = createSignal<PlayerSession | null>(initialSession());

  return (
    <Show
      when={session()}
      fallback={<JoinScreen onJoined={(s) => (saveSession(s), setSession(s))} />}
    >
      {(s) => (
        <WaitingScreen
          session={s()}
          onLost={() => {
            setSession(null);
          }}
        />
      )}
    </Show>
  );
};

render(() => <App />, document.getElementById('root') as HTMLElement);
