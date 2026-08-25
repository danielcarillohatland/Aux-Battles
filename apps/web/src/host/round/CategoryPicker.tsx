/**
 * AUX BATTLES — host round flow, CATEGORY step (frontend-spec §2).
 * Grid of preset categories + free-text override. Picking one arms the
 * Lock button; locking dispatches PICK_CATEGORY via REST (D-D) and the FSM
 * moves the room to SCENARIO — the UI just reflects whatever the snapshot says.
 *
 * Presentational only: zero animation delays (owner condition #10); all
 * mutation flows upward through onPick.
 */
import { createSignal, For } from 'solid-js';

/** Party-tested presets — tap-to-pick chips under the free-text box. */
export const PRESET_CATEGORIES = [
  'breakup anthems',
  'one-hit wonders',
  'songs for the gym',
  'rainy day',
  'road trip',
  '90s nostalgia',
  'karaoke killers',
  'villain era',
] as const;

export interface CategoryPickerProps {
  busy: boolean;
  onPick: (category: string) => void;
}

export const CategoryPicker = (props: CategoryPickerProps) => {
  const [text, setText] = createSignal('');
  const [preset, setPreset] = createSignal<string | null>(null);

  /** Free-text wins whenever it has content; otherwise the chosen preset. */
  const chosen = (): string | undefined => {
    const t = text().trim();
    return t !== '' ? t : (preset() ?? undefined);
  };

  const lock = () => {
    const c = chosen();
    if (c !== undefined && !props.busy) props.onPick(c);
  };

  return (
    <div class="round-card category-picker" role="group" aria-label="Pick a category">
      <h2 class="round-heading">pick a category</h2>
      <input
        class="p-input"
        placeholder="or type your own…"
        value={text()}
        onInput={(e) => setText(e.currentTarget.value)}
        maxLength={40}
        aria-label="Custom category"
      />
      <div class="category-grid">
        <For each={[...PRESET_CATEGORIES]}>
          {(c) => (
            <button
              type="button"
              class="cat-chip"
              classList={{ selected: preset() === c && text().trim() === '' }}
              onClick={() => {
                setText('');
                setPreset(c);
              }}
            >
              {c}
            </button>
          )}
        </For>
      </div>
      <button
        type="button"
        class="btn-primary btn-start"
        disabled={chosen() === undefined || props.busy}
        onClick={lock}
      >
        {props.busy ? 'Locking…' : 'Lock Category ✓'}
      </button>
    </div>
  );
};
