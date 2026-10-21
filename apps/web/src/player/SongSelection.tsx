/**
 * Song selection screen (frontend-spec §2.6) — keyboard ergonomics are the job.
 *
 * - Search input pinned TOP, debounced 300 ms, min 2 chars, ≤20 results.
 * - Tap a card → sticky pick bar appears above the safe-area inset with the
 *   selected track + big lock button.
 * - Lock is a TWO-STEP: first tap morphs the button into "SURE? 🔒" for 1.5 s;
 *   second tap within the window submits. Miss the window → back to LOCK IT IN.
 * - Zero animation delays: state swaps are instant, transitions have no delay.
 */
import { createEffect, createSignal, For, onCleanup, Show } from 'solid-js';
import type { JSX } from 'solid-js';
import type { Track } from '@aux/shared';
import { DEFENSE_MAX } from '@aux/shared';
import { searchTracks, submitTrack } from './api.js';
import type { SearchOutcome, SubmitFailure } from './api.js';
import { saveSubmission } from './submission-store.js';
import { TrackCard } from '../shared-ui/track-card.js';
import type { PlayerSession } from './session.js';
import { VibeLine } from '../shared-ui/vibe-line.js';

const SEARCH_DEBOUNCE_MS = 300;
const SEARCH_MIN_CHARS = 2;
const SURE_WINDOW_MS = 1_500;

const HINT_CHIPS = ['heartbreak', 'victory', 'chaos'];

type SearchView =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'error'; message: string }
  | { kind: 'empty' }
  | { kind: 'results'; tracks: Track[] };

const SUBMIT_COPY: Record<SubmitFailure['kind'], string> = {
  already_submitted: 'already locked',
  wrong_phase: 'round ended',
  too_late: 'time ran out',
  rate_limited: 'try again soon',
  not_found: 'rejoin the room',
  other: 'try again',
};

export function SongSelection(props: {
  session: PlayerSession;
  roundIdx: number;
  /** The scene and its agreed feeling stay visible while picking. */
  scenario?: string;
  vibe?: string | null;
  countdownSeconds: () => number | null;
  /** Called once a submission is accepted (or already present) — parent flips to sealed. */
  onSealed: () => void;
}): JSX.Element {
  const [query, setQuery] = createSignal('');
  const [view, setView] = createSignal<SearchView>({ kind: 'idle' });
  const [selected, setSelected] = createSignal<Track | null>(null);
  const [manualOpen, setManualOpen] = createSignal(false);
  const [manualTitle, setManualTitle] = createSignal('');
  const [manualArtist, setManualArtist] = createSignal('');
  const [sureArmed, setSureArmed] = createSignal(false);
  const [submitting, setSubmitting] = createSignal(false);
  const [submitError, setSubmitError] = createSignal<string | null>(null);
  const [defense, setDefense] = createSignal('');

  let searchInput: HTMLInputElement | undefined;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let sureTimer: ReturnType<typeof setTimeout> | undefined;
  let requestSeq = 0; // stale-response guard across debounce bursts

  queueMicrotask(() => searchInput?.focus()); // autofocus opens the keyboard immediately

  onCleanup(() => {
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    if (sureTimer !== undefined) clearTimeout(sureTimer);
  });

  // ── Debounced search ────────────────────────────────────────────────────────

  createEffect(() => {
    const q = query().trim();
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);

    if (q.length < SEARCH_MIN_CHARS) {
      requestSeq += 1; // invalidate any in-flight request
      setView({ kind: 'idle' });
      return;
    }

    setView({ kind: 'loading' });
    debounceTimer = setTimeout(() => void runSearch(q), SEARCH_DEBOUNCE_MS);
  });

  const runSearch = async (q: string): Promise<void> => {
    const seq = ++requestSeq;
    const outcome: SearchOutcome = await searchTracks(q, props.session.playerToken);
    if (seq !== requestSeq || query().trim() !== q) return; // superseded
    switch (outcome.status) {
      case 'ok':
        setView(
          outcome.tracks.length > 0
            ? { kind: 'results', tracks: outcome.tracks }
            : { kind: 'empty' },
        );
        return;
      case 'unavailable':
        setView({ kind: 'unavailable' });
        return;
      case 'error':
        setView({ kind: 'error', message: outcome.message });
        return;
    }
  };

  const searchNow = (): void => {
    const q = query().trim();
    if (q.length < SEARCH_MIN_CHARS) return;
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    setView({ kind: 'loading' });
    void runSearch(q);
  };

  // ── Timer-expiry auto-lock (§2.7): lock whatever is selected when time dies ──

  createEffect(() => {
    const left = props.countdownSeconds();
    if (left !== 0 || submitting()) return;
    const pick = selected();
    if (pick) void doSubmit(pick); // best effort — server may already be past SONG_SELECTION
  });

  // ── Pick + two-step confirm ────────────────────────────────────────────────

  const disarmSure = (): void => {
    if (sureTimer !== undefined) clearTimeout(sureTimer);
    sureTimer = undefined;
    setSureArmed(false);
  };

  const pick = (track: Track): void => {
    setSubmitError(null);
    disarmSure(); // changing your pick resets the SURE? window
    setSelected((cur) => (cur?.id === track.id ? null : track));
  };

  const openManualEntry = (): void => {
    if (manualTitle().trim() === '' && query().trim() !== '') setManualTitle(query().trim());
    setManualOpen(true);
  };

  const chooseManualTrack = (): void => {
    const title = manualTitle().trim();
    const artist = manualArtist().trim();
    if (title === '' || artist === '') return;
    pick({
      id: `manual:${encodeURIComponent(title.toLowerCase())}:${encodeURIComponent(artist.toLowerCase())}`,
      title,
      artist,
      source: 'manual',
    });
    setManualOpen(false);
  };

  const armOrConfirm = (): void => {
    const pickNow = selected();
    if (!pickNow || submitting()) return;
    if (sureArmed()) {
      disarmSure(); // consume the armed state regardless of outcome
      void doSubmit(pickNow);
      return;
    }
    setSureArmed(true);
    if (sureTimer !== undefined) clearTimeout(sureTimer);
    sureTimer = setTimeout(disarmSure, SURE_WINDOW_MS); // miss the window → back to LOCK IT IN
  };

  const doSubmit = async (track: Track): Promise<void> => {
    setSubmitting(true);
    setSubmitError(null);
    const result = await submitTrack(props.session, track, props.roundIdx, defense());
    setSubmitting(false);
    if (result.ok || result.failure.kind === 'already_submitted') {
      saveSubmission(props.session.code, {
        roundIdx: props.roundIdx,
        track,
        clientMsgId: 'cm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10), // local bookkeeping id
      });
      navigator.vibrate?.([20, 40, 20]); // seal thunk
      props.onSealed();
      return;
    }
    if (result.failure.kind === 'not_found') {
      props.onSealed(); // room/token trouble — the parent's realtime path surfaces it
      return;
    }
    setSubmitError(SUBMIT_COPY[result.failure.kind]);
    if (result.failure.kind === 'wrong_phase' || result.failure.kind === 'too_late') {
      setSelected(null); // phase moved on — nothing to lock anymore
    }
  };

  return (
    <div class="p-screen p-select">
      <header class="p-top">
        <span class="kicker">Round {(props.roundIdx ?? 0) + 1} · pick a song</span>
        <Show when={props.countdownSeconds() !== null}>
          <span class="p-timer mono" role="timer">
            {props.countdownSeconds()}s
          </span>
        </Show>
      </header>
      <Show when={props.scenario}>
        <div class="p-brief">
          <p class="p-brief-scene">{props.scenario}</p>
          <VibeLine vibe={props.vibe} />
        </div>
      </Show>

      {/* Search pinned top — never fights the open keyboard. */}
      <div class="p-search-wrap">
        <span class="p-search-icon" aria-hidden="true" />
        <input
          ref={searchInput}
          class="field p-search-input"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              searchNow();
            }
          }}
          placeholder="search songs…"
          enterkeyhint="search"
          autocomplete="off"
          autocorrect="off"
          spellcheck={false}
          aria-label="Search songs"
        />
        <Show when={query().length > 0}>
          <button
            type="button"
            class="p-search-clear"
            onClick={() => setQuery('')}
            aria-label="Clear search"
          >
            ×
          </button>
        </Show>
      </div>

      <section class="p-manual-entry">
        <Show
          when={manualOpen()}
          fallback={
            <button type="button" class="p-link" onClick={openManualEntry}>
              Can't find it? Enter any song
            </button>
          }
        >
          <form
            class="p-manual-form"
            onSubmit={(event) => {
              event.preventDefault();
              chooseManualTrack();
            }}
          >
            <p class="kicker">Any song · no account needed</p>
            <label class="p-manual-field">
              <span>Song title</span>
              <input
                class="field"
                value={manualTitle()}
                onInput={(event) => setManualTitle(event.currentTarget.value)}
                maxlength={80}
                autocomplete="off"
                required
              />
            </label>
            <label class="p-manual-field">
              <span>Artist</span>
              <input
                class="field"
                value={manualArtist()}
                onInput={(event) => setManualArtist(event.currentTarget.value)}
                maxlength={80}
                autocomplete="off"
                required
              />
            </label>
            <div class="p-manual-actions">
              <button
                type="button"
                class="btn btn--ghost btn--small"
                onClick={() => setManualOpen(false)}
              >
                Cancel
              </button>
              <button
                type="submit"
                class="btn btn--small"
                disabled={manualTitle().trim() === '' || manualArtist().trim() === ''}
              >
                Use this song
              </button>
            </div>
          </form>
        </Show>
      </section>

      {/* Results area sized to remaining viewport (dvh). */}
      <div class="p-results" aria-live="polite">
        <Show when={view()} keyed>
          {(v) => (
            <>
              <Show when={v.kind === 'idle'}>
                <div class="p-results-state">
                  <p class="p-state-title">Search any song</p>
                  <p class="p-fine">Title, artist, or a lyric you half remember.</p>
                  <div class="p-chips">
                    <For each={HINT_CHIPS}>
                      {(chip) => (
                        <button type="button" class="p-chip" onClick={() => setQuery(chip)}>
                          try: {chip}
                        </button>
                      )}
                    </For>
                  </div>
                </div>
              </Show>

              <Show when={v.kind === 'loading'}>
                <For each={[0, 1, 2, 3]}>
                  {() => (
                    <div class="track-card p-skel" aria-hidden="true">
                      <span class="track-art" />
                      <span class="track-meta">
                        <span class="p-skel-line" />
                        <span class="p-skel-line p-skel-line--short" />
                      </span>
                    </div>
                  )}
                </For>
              </Show>

              {/* A missing catalog route is recoverable but should be visible. */}
              <Show when={v.kind === 'unavailable'}>
                <div class="p-results-state">
                  <p class="p-state-title">No catalog connected</p>
                  <p class="p-fine">Enter any title and artist above. No setup needed.</p>
                </div>
              </Show>

              <Show when={v.kind === 'error'}>
                <div class="p-results-state">
                  <p class="p-error">{v.kind === 'error' ? v.message : ''}</p>
                  <p class="p-fine">You can still enter any song above.</p>
                </div>
              </Show>

              <Show when={v.kind === 'empty'}>
                <div class="p-results-state">
                  <p class="p-state-title">Nothing for “{query().trim()}”</p>
                  <p class="p-fine">Try the artist, or enter it manually above.</p>
                </div>
              </Show>

              <Show when={v.kind === 'results'}>
                <p class="kicker p-results-summary">
                  {v.kind === 'results' ? v.tracks.length : 0} results
                </p>
                <For each={v.kind === 'results' ? v.tracks : []}>
                  {(track) => (
                    <TrackCard
                      track={track}
                      selected={selected()?.id === track.id}
                      onSelect={pick}
                    />
                  )}
                </For>
              </Show>
            </>
          )}
        </Show>
      </div>

      {/* Sticky pick bar ABOVE the keyboard / safe-area. */}
      <Show when={selected()}>
        <div class="p-pick-bar pop">
          <Show when={selected()} keyed>
            {(t) => (
              <div class="p-pick-info">
                <span class="kicker">Your pick</span>
                <span class="p-pick-title">{t.title}</span>
                <span class="p-pick-artist">{t.artist}</span>
              </div>
            )}
          </Show>
          <label class="p-defense">
            <span class="kicker p-defense-label">
              Defend it <em>(the judge reads this)</em>
              <span class="mono">
                {defense().length}/{DEFENSE_MAX}
              </span>
            </span>
            <textarea
              class="field p-defense-input"
              rows="2"
              maxlength={DEFENSE_MAX}
              placeholder="why this song, why now…"
              value={defense()}
              enterkeyhint="done"
              onInput={(e) => setDefense(e.currentTarget.value.slice(0, DEFENSE_MAX))}
            />
          </label>
          <button
            type="button"
            class="btn btn--big btn--block p-lock"
            classList={{ 'btn--primary': !sureArmed(), 'btn--lime': sureArmed() }}
            disabled={!selected() || submitting()}
            onClick={armOrConfirm}
          >
            {submitting() ? 'Locking…' : sureArmed() ? 'Sure? Tap to confirm' : 'Lock it in'}
          </button>
          <Show when={submitError()}>
            <p class="p-error" role="alert">
              {submitError()}
            </p>
          </Show>
        </div>
      </Show>
    </div>
  );
}
