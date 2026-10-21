/**
 * SCENARIO step: the prompt as a poster, plus a slim countdown driven entirely by
 * the absolute `phaseEndsAt` deadline (D-C). The screen never advances anything.
 */
import { createSignal, onCleanup, Show } from 'solid-js';
import { SCENARIO_DISPLAY_MS } from '@aux/shared';
import { VibeLine } from '../../shared-ui/vibe-line.js';

export interface ScenarioDisplayProps {
  scenario: string;
  vibe?: string | null | undefined;
  category: string | null | undefined;
  roundNumber: number;
  countdownSeconds: number | null;
}

export const ScenarioDisplay = (props: ScenarioDisplayProps) => {
  const [revealed, setRevealed] = createSignal(false);
  const revealTimer = setTimeout(() => setRevealed(true), 700);
  onCleanup(() => clearTimeout(revealTimer));
  const fraction = (): number =>
    props.countdownSeconds === null
      ? 0
      : Math.min(1, Math.max(0, (props.countdownSeconds * 1000) / SCENARIO_DISPLAY_MS));

  return (
    <section class="screen poster" role="status">
      <Show
        when={revealed()}
        fallback={
          <div class="poster-intro pop">
            <p class="kicker">Round {props.roundNumber}</p>
            <h2 class="display poster-intro-title">{props.category ?? 'Here it comes'}</h2>
          </div>
        }
      >
        <p class="kicker rise">
          Round {props.roundNumber}
          <Show when={props.category}>
            {' '}
            · <b>{props.category}</b>
          </Show>
        </p>
        <h2 class="display poster-scene rise">{props.scenario || 'Something devious…'}</h2>
        <VibeLine vibe={props.vibe} class="poster-vibe rise" />
        <p class="poster-hint rise">Players are picking. Songs lock when the clock runs out.</p>
      </Show>
      <div class="poster-timer" aria-hidden={props.countdownSeconds === null}>
        <span class="poster-timer-bar">
          <i style={{ width: `${fraction() * 100}%` }} />
        </span>
        <Show when={props.countdownSeconds !== null}>
          <span class="mono" role="timer">
            {props.countdownSeconds}s
          </span>
        </Show>
      </div>
    </section>
  );
};
