/**
 * Sealed / waiting screen: your pick is locked, now watch the room fill up.
 * CHICKEN: the timer ran out and the server assigned a random song.
 */
import { For, Show } from 'solid-js';
import type { JSX } from 'solid-js';
import type { Track } from '@aux/shared';
import { TrackArt } from '../shared-ui/track-card.js';

const WAITING_COPY = [
  'Waiting for the others',
  'Someone is still scrolling',
  'No take-backs',
  'Judge warming up',
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
  const statusLine = () => WAITING_COPY[props.roundIdx % WAITING_COPY.length]!;
  const n = () => props.submitted() ?? 0;
  const m = () => props.totalPlayers() ?? 0;

  return (
    <div class="p-screen p-sealed" data-chicken={props.chicken ? 'true' : undefined}>
      <header class="p-top">
        <span class="kicker">Round {props.roundIdx + 1}</span>
        <Show when={props.countdownSeconds() !== null && !props.chicken}>
          <span class="p-timer mono" role="timer">
            {props.countdownSeconds()}s
          </span>
        </Show>
      </header>

      <div class="p-sealed-card pop">
        <span class="stamp" classList={{ 'stamp--cream': props.chicken }}>
          {props.chicken ? 'Chicken' : 'Locked'}
        </span>
        <Show
          when={props.chicken}
          fallback={
            <Show when={props.track} keyed>
              {(t) => (
                <div class="p-sealed-pick">
                  <TrackArt track={t} size={72} />
                  <span class="p-sealed-title">{t.title}</span>
                  <span class="p-sealed-artist">{t.artist}</span>
                </div>
              )}
            </Show>
          }
        >
          <p class="p-sealed-title">Time ran out.</p>
          <p class="p-sealed-artist">The judge picked something for you. Own it.</p>
        </Show>
      </div>

      <div class="p-progress" role="status">
        <ul class="p-slots" aria-hidden="true">
          <For each={Array.from({ length: Math.max(m(), 1) }, (_, i) => i)}>
            {(i) => <li classList={{ 'is-filled': i < n() }} />}
          </For>
        </ul>
        <p class="p-progress-text">
          <strong class="mono">
            {n()}/{m()}
          </strong>{' '}
          locked · {props.chicken ? 'the show goes on' : statusLine()}
        </p>
      </div>
    </div>
  );
}
