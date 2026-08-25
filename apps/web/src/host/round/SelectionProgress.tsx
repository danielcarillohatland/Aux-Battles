/**
 * AUX BATTLES — host round flow, SONG_SELECTION step.
 * Live progress: N of M players locked in. N arrives via snapshot
 * `submissionsCount` on every state_change frame (count-only — D-D keeps
 * submissions anonymous); M is the connected-roster size.
 */
import { Show } from 'solid-js';

export interface SelectionProgressProps {
  submittedCount: number;
  totalPlayers: number;
  countdownSeconds: number | null;
}

export const SelectionProgress = (props: SelectionProgressProps) => {
  const pct = () =>
    props.totalPlayers === 0
      ? 0
      : Math.min(100, Math.round((props.submittedCount / props.totalPlayers) * 100));

  return (
    <div class="round-card selection-progress" role="status">
      <h2 class="round-heading">song picking</h2>
      <p class="progress-count">
        <strong>{props.submittedCount}</strong>/{props.totalPlayers} locked in
      </p>
      <div
        class="progress-bar"
        role="progressbar"
        aria-valuenow={props.submittedCount}
        aria-valuemin={0}
        aria-valuemax={props.totalPlayers}
      >
        <div class="progress-fill" style={{ width: `${pct()}%` }} />
      </div>
      <Show when={props.countdownSeconds !== null}>
        <p class="hint">{props.countdownSeconds}s until auto-lock 🐔</p>
      </Show>
      <Show when={props.submittedCount >= props.totalPlayers && props.totalPlayers > 0}>
        <p class="hint">everyone’s in — locking…</p>
      </Show>
    </div>
  );
};
