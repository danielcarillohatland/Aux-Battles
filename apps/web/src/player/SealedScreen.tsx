/**
 * Sealed / waiting screen (frontend-spec §2.7) — full-screen takeover, calm but alive.
 *
 * - SEALED 🤐: giant padlock over your frosted choice; resubmission UI is gone.
 *   Live "waiting for others… N/M submitted" fed by WS `submission_received`
 *   count frames via the realtime handle's `submissionCount` signal, with the
 *   polling fallback keeping it truthful when WS is down (ws.ts owns that).
 * - CHICKEN 🐔: the timer expired before you locked and the AI judge assigned
 *   you a random song — shame-as-mechanics display state.
 */
import { For, Show } from 'solid-js';
import type { JSX } from 'solid-js';
import type { Track } from '@aux/shared';
import { TrackArt } from '../shared-ui/track-card.js';

const WAITING_COPY = [
  'waiting for stragglers…',
  'someone out there is still scrolling…',
  'the lock is sealed. no takebacks.',
  'sharpening the judge…',
];

export function SealedScreen(props: {
  nickname: string;
  track: Track | null;
  chicken: boolean;
  roundIdx: number;
  submitted: () => number | null;
  totalPlayers: () => number | null;
  countdownSeconds: () => number | null;
}): JSX.Element {
  const statusLine = (): string => {
    const lines = WAITING_COPY;
    return lines[props.roundIdx % lines.length] ?? lines[0]!;
  };
  const progress = (): string => {
    const n = props.submitted();
    const m = props.totalPlayers();
    if (n === null || m === null || m === 0) return 'counting heads…';
    return `waiting for others… ${n}/${m} submitted`;
  };

  return (
    <div class="p-screen p-sealed-screen" data-chicken={props.chicken ? 'true' : undefined}>
      <header class="p-head">
        <p class="p-round-tag">round {props.roundIdx + 1}</p>
      </header>

      <div class="p-card p-seal-card">
        <span class="p-seal-lock" aria-hidden="true">
          🔒
        </span>

        <Show
          when={props.chicken}
          fallback={
            <>
              <p class="p-seal-stamp">SEALED 🤐</p>
              <Show when={props.track} keyed>
                {(t) => (
                  <div class="p-seal-pick">
                    <TrackArt track={t} size={56} class="p-seal-art" />
                    <span class="p-seal-track">{t.title}</span>
                    <span class="p-seal-artist">{t.artist}</span>
                  </div>
                )}
              </Show>
            </>
          }
        >
          {/* Timer expired with nothing picked — the judge assigned a random song. */}
          <p class="p-chicken-stamp">CHICKEN 🐔</p>
          <p class="p-sub">time ran out — the judge picked a random song for you</p>
        </Show>

        <p class="p-progress" role="status">
          {progress()}
        </p>

        <Show when={props.countdownSeconds() !== null && !props.chicken}>
          <p class="p-countdown" role="timer">
            {props.countdownSeconds()}s
          </p>
        </Show>

        <div class="p-peer-dots" aria-hidden="true">
          <For each={[0, 1, 2]}>{(i) => <span class="p-peer-dot" data-n={String(i)} />}</For>
        </div>

        <p class="p-hint">{props.chicken ? 'own it. reveal will be glorious.' : statusLine()}</p>
      </div>
    </div>
  );
}
