/** The agreed feeling for the round's scene, shown wherever the scene is shown. */
import { Show } from 'solid-js';

export function VibeLine(props: { vibe: string | null | undefined; class?: string }) {
  return (
    <Show when={props.vibe}>
      {(vibe) => (
        <p class={`vibe-line ${props.class ?? ''}`}>
          <span class="vibe-line__label">The vibe</span>
          <span class="vibe-line__text">{vibe()}</span>
        </p>
      )}
    </Show>
  );
}
