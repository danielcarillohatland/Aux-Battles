/**
 * AUX BATTLES — host round flow, LOCKED step (staging).
 * Everyone's answers are sealed; the room holds here until the host taps
 * Begin Playback, which dispatches BEGIN_PLAYBACK via REST (D-D) and the
 * FSM moves the whole room to PLAYBACK.
 */
import { Show } from 'solid-js';

export interface LockedStagingProps {
  submittedCount: number;
  busy: boolean;
  onBegin: () => void;
}

export const LockedStaging = (props: LockedStagingProps) => (
  <div class="round-card locked-staging">
    <h2 class="round-heading">answers locked 🔒</h2>
    <p class="locked-count">{props.submittedCount} songs sealed &amp; shuffled</p>
    <p class="hint">nobody knows whose is whose. that’s the whole point.</p>
    <Show when={props.submittedCount === 0}>
      <p class="hint">…although this round seems to be sealed empty 🤨</p>
    </Show>
    <button
      type="button"
      class="btn-primary btn-start"
      disabled={props.busy}
      onClick={() => props.onBegin()}
    >
      {props.busy ? 'Cueing…' : 'Begin Playback ▶'}
    </button>
  </div>
);
