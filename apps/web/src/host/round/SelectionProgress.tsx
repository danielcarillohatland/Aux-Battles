/**
 * SONG_SELECTION step: N of M locked in. N arrives via snapshot
 * `submissionsCount` (count-only — D-D keeps submissions anonymous).
 */
import { For, Show } from 'solid-js';
import { VibeLine } from '../../shared-ui/vibe-line.js';

export interface SelectionProgressProps {
  scenario: string;
  vibe?: string | null | undefined;
  submittedCount: number;
  totalPlayers: number;
  countdownSeconds: number | null;
}

export const SelectionProgress = (props: SelectionProgressProps) => {
  const slots = () => Array.from({ length: Math.max(props.totalPlayers, 1) }, (_, i) => i);
  return (
    <section class="screen picks" role="status">
      <p class="kicker">Picks incoming</p>
      <p class="picks-scene">{props.scenario}</p>
      <VibeLine vibe={props.vibe} />
      <div class="picks-count">
        <strong class="display mono">{props.submittedCount}</strong>
        <span class="muted mono">/ {props.totalPlayers}</span>
      </div>
      <ul class="picks-slots" aria-hidden="true">
        <For each={slots()}>
          {(i) => <li classList={{ 'is-filled': i < props.submittedCount }} />}
        </For>
      </ul>
      <Show
        when={props.submittedCount >= props.totalPlayers && props.totalPlayers > 0}
        fallback={
          <Show when={props.countdownSeconds !== null}>
            <p class="muted">
              Auto-lock in <span class="mono">{props.countdownSeconds}s</span>
            </p>
          </Show>
        }
      >
        <p class="muted">Everyone is in. Locking…</p>
      </Show>
    </section>
  );
};
