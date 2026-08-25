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
import { joinRoom } from './api.js';
import type { JoinFailure } from './api.js';
import { clearSession, loadSession, readUrlCode, saveSession } from './session.js';
import type { PlayerSession } from './session.js';
import { createPlayerRealtime } from './ws.js';

// ── Join screen ───────────────────────────────────────────────────────────────

const JoinScreen = (props: { onJoined: (s: PlayerSession) => void }) => {
  const [code, setCode] = createSignal(readUrlCode());
  const [nick, setNick] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [failure, setFailure] = createSignal<JoinFailure | null>(null);
  const [rateLeft, setRateLeft] = createSignal(0);

  let codeInput: HTMLInputElement | undefined;
  let nickInput: HTMLInputElement | undefined;

  const codeValid = () => RoomCodeSchema.safeParse(code()).success;
  const nickValid = () => NicknameSchema.safeParse(nick()).success;
  const canJoin = () => codeValid() && nickValid() && !busy() && rateLeft() === 0;

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
    const result = await joinRoom(code(), nick().trim());
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
        return "that nickname's taken — pick another";
      case 'room_not_found':
        return 'room not found — check the code';
      case 'rate_limited': {
        const n = rateLeft();
        return n > 0 ? `slow down 🐢 try again in ${n}s` : 'slow down 🐢 give it a few seconds';
      }
      case 'other': {
        const f = failure();
        return f && f.kind === 'other' ? f.message : 'something broke — try again';
      }
      default:
        return '';
    }
  };

  return (
    <form class="p-screen" onSubmit={submit}>
      <header class="p-head">
        <h1>AUX ⚔ BATTLES</h1>
        <p class="p-sub">one song. one winner.</p>
      </header>

      <div class="p-card">
        <label class="p-label" for="p-code">
          room code
        </label>
        <input
          id="p-code"
          ref={codeInput}
          class="p-input p-code-input"
          classList={{ 'p-bad': failure()?.kind === 'room_not_found' }}
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
        />
        <Show when={code().length === 5 && !codeValid()}>
          <p class="p-hint">codes are 5 letters/numbers</p>
        </Show>

        <label class="p-label" for="p-nick">
          your name
        </label>
        <input
          id="p-nick"
          ref={nickInput}
          class="p-input"
          classList={{ 'p-bad': failure()?.kind === 'name_taken' }}
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
        />
        <Show when={nick().length > 0 && !nickValid()}>
          <p class="p-hint">pick something short enough to shout</p>
        </Show>

        <Show when={failure()}>
          <p class="p-error" role="alert">
            {errorCopy()}
          </p>
        </Show>
      </div>

      {/* Sticky CTA: never swallowed by the mobile keyboard. */}
      <div class="p-cta-bar">
        <button type="submit" class="p-cta" disabled={!canJoin()}>
          <Show when={!busy()} fallback="joining…">
            JOIN ▶
          </Show>
        </button>
        <Show when={codeValid()}>
          <p class="p-strip">room {code()} ✓</p>
        </Show>
      </div>
    </form>
  );
};

// ── Waiting screen ────────────────────────────────────────────────────────────

/** Friendly FSM label shown live from the realtime snapshot. */
const STATE_LABEL: Record<Snapshot['state'], string> = {
  LOBBY: 'waiting for host…',
  CATEGORY: 'host is picking a category',
  SCENARIO: 'scenario incoming…',
  SONG_SELECTION: 'pick your song!',
  LOCKED: 'answers locked — good luck',
  PLAYBACK: 'listening party 🎶',
  AI_JUDGING: 'the judge deliberates…',
  RESULTS: 'results are in',
  LEADERBOARD: 'leaderboard time',
  GAME_OVER: "that's a wrap!",
};

const WaitingScreen = (props: { session: PlayerSession; onLost: () => void }) => {
  const [kickCopy, setKickCopy] = createSignal<string | null>(null);

  // Realtime first (single WS per client, D-D); polling fallback is built in.
  let rt!: ReturnType<typeof createPlayerRealtime>;
  onMount(() => {
    rt = createPlayerRealtime({
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
  });
  onCleanup(() => rt?.stop());

  const state = (): Snapshot['state'] => rt?.snapshot()?.state ?? 'LOBBY';
  const count = () => rt?.snapshot()?.players.length ?? null;
  const countdown = () => rt?.countdownSeconds() ?? null;
  const connState = () => rt?.connState() ?? 'connecting';

  return (
    <div class="p-screen">
      <header class="p-head">
        <h1>AUX ⚔ BATTLES</h1>
      </header>
      <div class="p-card p-waiting">
        <p class="p-in">you're in, {props.session.nickname} 🎧</p>
        <span class="p-dot" aria-hidden="true" />
        <p class="p-sub">
          {count() === null ? 'counting heads…' : `${count()} player${count() === 1 ? '' : 's'} in`}
        </p>
        <Show when={countdown() !== null}>
          <p class="p-countdown" role="timer">
            {countdown()}s left
          </p>
        </Show>
        {/* Live FSM state label straight off the realtime snapshot. */}
        <p class="p-wait-copy" data-state={state()}>
          {STATE_LABEL[state()]}
          <Show when={connState() !== 'live'}>
            {' '}
            · {connState() === 'polling' ? '(polling)' : '(reconnecting…)'}
          </Show>
        </p>
        <Show when={kickCopy()}>
          <p class="p-error" role="alert">
            {kickCopy()}
          </p>
        </Show>
        <p class="p-hint">keep this tab open — you're {props.session.code}</p>
      </div>
    </div>
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
