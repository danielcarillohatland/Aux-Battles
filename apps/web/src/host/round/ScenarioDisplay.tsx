/**
 * AUX BATTLES — host round flow, SCENARIO step.
 * The current scenario/category rendered BIG plus an auto-advance countdown
 * ring driven entirely by the absolute `phaseEndsAt` deadline (D-C): the
 * server timer fires the transition; this screen never advances anything,
 * it only renders the remaining slice locally so drift can't touch it.
 */
import { Show } from 'solid-js';
import { SCENARIO_DISPLAY_MS } from '@aux/shared';

export interface ScenarioDisplayProps {
  scenario: string;
  /** Seconds left, computed locally from phaseEndsAt by the realtime engine. */
  countdownSeconds: number | null;
}

const RING_RADIUS = 54;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export const ScenarioDisplay = (props: ScenarioDisplayProps) => {
  // Remaining fraction of the phase (1 → full ring). Falls open when untimed.
  const fraction = (): number =>
    props.countdownSeconds === null
      ? 0
      : Math.min(1, Math.max(0, (props.countdownSeconds * 1000) / SCENARIO_DISPLAY_MS));

  const timed = (): boolean => props.countdownSeconds !== null;

  return (
    <div class="round-card scenario-display" role="status">
      <h2 class="round-heading">this round’s scenario</h2>
      <p class="scenario-big">{props.scenario || 'something devious…'}</p>
      <div class="scenario-timer">
        <Show when={timed()} fallback={<span class="timer-flat">untimed</span>}>
          <svg
            class="countdown-ring"
            viewBox={`0 0 ${RING_RADIUS * 2 + 8} ${RING_RADIUS * 2 + 8}`}
            role="img"
            aria-label={`${Math.ceil(props.countdownSeconds ?? 0)} seconds left`}
          >
            <circle class="ring-track" cx={RING_RADIUS + 4} cy={RING_RADIUS + 4} r={RING_RADIUS} />
            {/* dashoffset shrinks as time runs out; no transitions (cond #10). */}
            <circle
              class="ring-fill"
              cx={RING_RADIUS + 4}
              cy={RING_RADIUS + 4}
              r={RING_RADIUS}
              stroke-dasharray={String(RING_CIRCUMFERENCE)}
              stroke-dashoffset={String(RING_CIRCUMFERENCE * (1 - fraction()))}
            />
          </svg>
        </Show>
        <span class="countdown-num">
          <Show when={timed()}>{props.countdownSeconds}s</Show>
        </span>
      </div>
      <p class="hint">song picking starts automatically when the ring empties</p>
    </div>
  );
};
