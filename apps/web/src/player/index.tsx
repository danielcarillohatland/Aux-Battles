/**
 * Player app — phone join flow + waiting screen (TDD §9, frontend-spec §2.3).
 * Single screen, two fields, sticky CTA above the keyboard. Fewer clicks per owner philosophy.
 */
import { createEffect, createSignal, onCleanup, onMount, Show } from 'solid-js';
import { render } from 'solid-js/web';
import { NICKNAME_MAX, NicknameSchema, RoomCodeSchema } from '@aux/shared';
import '../shared-ui/shell.css';
import './player.css';
import { fetchPlayerCount, joinRoom } from './api.js';
import type { JoinFailure } from './api.js';
import { clearSession, loadSession, readUrlCode, saveSession } from './session.js';
import type { PlayerSession } from './session.js';

const POLL_MS = 3_000;

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

const WaitingScreen = (props: { session: PlayerSession; onLost: () => void }) => {
  const [count, setCount] = createSignal<number | null>(null);

  onMount(() => {
    let alive = true;

    const poll = async () => {
      const n = await fetchPlayerCount(props.session.code);
      if (!alive) return;
      if (n === null) {
        clearSession(); // room's gone — dead ends are banned, so send them back to rejoin
        props.onLost();
        return;
      }
      setCount(n);
    };

    void poll();
    const t = setInterval(poll, POLL_MS);
    onCleanup(() => {
      alive = false;
      clearInterval(t);
    });
  });

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
        <p class="p-wait-copy">waiting for host…</p>
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
