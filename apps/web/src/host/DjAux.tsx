import { createEffect, createSignal, onCleanup, Show } from 'solid-js';
import type { MascotMood } from './mascot-state.js';

interface DjAuxProps {
  mood: MascotMood;
  /** Compact badge (show bar) vs stage presence (landing / wide screens). */
  size?: 'badge' | 'stage';
  line?: string | undefined;
  /** Changes whenever DJ AUX should visibly deliver a line (mouth animation). */
  talkKey?: string | null | undefined;
}

/** How long the mouth moves after a verdict or reveal lands. */
export const TALK_DURATION_MS = 4_500;

/**
 * DJ AUX (D-034): one head asset, a visor-coloured mouth overlay for talking,
 * and a mood attribute that drives a distinct motion per game beat: welcome
 * (idle sway), search (scanning), listen (head-bob on the beat), think (tilt +
 * dots), praise (nod), roast (shake + steam), reveal (lean in), celebrate
 * (bounce). No rings, no glows: the character carries the moment.
 */
export const DjAux = (props: DjAuxProps) => {
  const [talking, setTalking] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  createEffect(() => {
    const key = props.talkKey;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (key === undefined || key === null) {
      setTalking(false);
      return;
    }
    setTalking(true);
    timer = setTimeout(() => setTalking(false), TALK_DURATION_MS);
  });
  onCleanup(() => {
    if (timer !== undefined) clearTimeout(timer);
  });

  return (
    <div
      class="aux"
      classList={{ 'aux--stage': props.size === 'stage', 'aux--badge': props.size !== 'stage' }}
      data-mood={props.mood}
      data-talking={talking() ? 'true' : 'false'}
      role="img"
      aria-label={props.line ? `DJ AUX: ${props.line}` : 'DJ AUX'}
    >
      <div class="aux-figure" aria-hidden="true">
        <div class="aux-head">
          <img
            class="aux-head-img"
            src="/assets/dj-aux-head.png"
            alt=""
            draggable={false}
            width="512"
            height="512"
          />
          <span class="aux-mouth" />
        </div>
        <span class="aux-fx aux-fx-a" />
        <span class="aux-fx aux-fx-b" />
        <span class="aux-fx aux-fx-c" />
      </div>
      <Show when={props.line}>
        {(line) => (
          <p class="aux-line">
            <span class="aux-name">DJ AUX</span>
            {line()}
          </p>
        )}
      </Show>
    </div>
  );
};
