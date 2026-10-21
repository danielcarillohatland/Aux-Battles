/**
 * LOCKED step: the deck is shuffled and sealed; the host taps Play to dispatch
 * BEGIN_PLAYBACK via REST (D-D) for the whole room.
 */
import { Show } from 'solid-js';

export interface LockedStagingProps {
  submittedCount: number;
  busy: boolean;
  onBegin: () => void;
}

export const LockedStaging = (props: LockedStagingProps) => (
  <section class="screen locked">
    <p class="kicker">Deck locked</p>
    <div class="deck pop" aria-hidden="true">
      <i />
      <i />
      <i />
      <strong class="display mono">{props.submittedCount}</strong>
    </div>
    <h2 class="display">
      {props.submittedCount} song{props.submittedCount === 1 ? '' : 's'} shuffled
    </h2>
    <p class="muted">Nobody knows who picked what. Yet.</p>
    <Show when={props.submittedCount === 0}>
      <p class="muted">This round appears to be empty.</p>
    </Show>
    <div class="stage-cta">
      <button
        type="button"
        class="btn btn--primary btn--big btn--block"
        disabled={props.busy}
        onClick={() => props.onBegin()}
      >
        {props.busy ? 'Cueing…' : 'Play the songs'}
      </button>
    </div>
  </section>
);
