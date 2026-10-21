/**
 * CATEGORY step (D-029): pick a vibe. A grid of vibe tickets plus a free-text
 * prompt. Locking dispatches PICK_CATEGORY via REST (D-D) with the vibe id, the
 * surprise sentinel, or the custom prompt; the server draws the scene.
 */
import { createSignal, For } from 'solid-js';
import { SCENARIO_THEMES, SURPRISE_THEME_ID } from '@aux/shared';

export interface CategoryPickerProps {
  busy: boolean;
  onPick: (category: string) => void;
}

export const CategoryPicker = (props: CategoryPickerProps) => {
  const [text, setText] = createSignal('');
  const [preset, setPreset] = createSignal<string | null>(null);

  const chosen = (): string | undefined => {
    const t = text().trim();
    return t !== '' ? t : (preset() ?? undefined);
  };
  const lock = () => {
    const c = chosen();
    if (c !== undefined && !props.busy) props.onPick(c);
  };
  const select = (id: string) => {
    setText('');
    setPreset(id);
  };

  return (
    <section class="screen vibes" role="group" aria-label="Pick a vibe">
      <p class="kicker">Round setup</p>
      <h2 class="display">Pick a vibe</h2>
      <div class="vibe-grid">
        <For each={[...SCENARIO_THEMES]}>
          {(theme, i) => (
            <button
              type="button"
              class="vibe rise"
              style={{ 'animation-delay': `${i() * 40}ms` }}
              classList={{ 'is-selected': preset() === theme.id && text().trim() === '' }}
              aria-pressed={preset() === theme.id && text().trim() === ''}
              onClick={() => select(theme.id)}
            >
              <span class="vibe-emoji" aria-hidden="true">
                {theme.emoji}
              </span>
              <span class="vibe-name">{theme.name}</span>
              <span class="vibe-tagline">{theme.tagline}</span>
            </button>
          )}
        </For>
        <button
          type="button"
          class="vibe vibe--surprise rise"
          classList={{ 'is-selected': preset() === SURPRISE_THEME_ID && text().trim() === '' }}
          aria-pressed={preset() === SURPRISE_THEME_ID && text().trim() === ''}
          onClick={() => select(SURPRISE_THEME_ID)}
        >
          <span class="vibe-emoji" aria-hidden="true">
            🎲
          </span>
          <span class="vibe-name">Surprise me</span>
          <span class="vibe-tagline">Any vibe, any scene</span>
        </button>
      </div>
      <label class="vibe-custom">
        <span class="kicker">Or write your own prompt</span>
        <input
          class="field"
          placeholder="e.g. songs for grandma's 80th"
          value={text()}
          onInput={(e) => setText(e.currentTarget.value)}
          maxLength={80}
          aria-label="Custom prompt"
        />
      </label>
      <div class="stage-cta">
        <button
          type="button"
          class="btn btn--primary btn--big btn--block"
          disabled={chosen() === undefined || props.busy}
          onClick={lock}
        >
          {props.busy ? 'Locking…' : text().trim() !== '' ? 'Use my prompt' : 'Lock it in'}
        </button>
      </div>
    </section>
  );
};
