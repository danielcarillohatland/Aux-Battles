/**
 * Song selection screen (frontend-spec §2.6) — keyboard ergonomics are the job.
 *
 * - Search input pinned TOP, debounced 300 ms, min 2 chars, ≤10 results.
 * - Tap a card → sticky pick bar appears above the safe-area inset with the
 *   selected track + big lock button.
 * - Lock is a TWO-STEP: first tap morphs the button into "SURE? 🔒" for 1.5 s;
 *   second tap within the window submits. Miss the window → back to LOCK IT IN.
 * - Zero animation delays: state swaps are instant, transitions have no delay.
 */
import { createEffect, createSignal, For, onCleanup, Show } from 'solid-js';
import type { JSX } from 'solid-js';
import type { Track } from '@aux/shared';
import { searchTracks, submitTrack } from './api.js';
import type { SearchOutcome, SubmitFailure } from './api.js';
import { saveSubmission } from './submission-store.js';
import { TrackCard } from '../shared-ui/track-card.js';
import type { PlayerSession } from './session.js';

const SEARCH_DEBOUNCE_MS = 300;
const SEARCH_MIN_CHARS = 2;
const SURE_WINDOW_MS = 1_500;

const HINT_CHIPS = ['heartbreak', 'gym', '2000s'];

type SearchView =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'error'; message: string }
  | { kind: 'empty' }
  | { kind: 'results'; tracks: Track[] };

const SUBMIT_COPY: Record<SubmitFailure['kind'], string> = {
  already_submitted: "you're already locked in 🤐",
  wrong_phase: 'the round moved on without you',
  too_late: 'too late — the timer beat you to it',
  rate_limited: 'slow down 🐢 give it a few seconds',
  not_found: 'lost the room — try rejoining',
  other: 'the lock jammed — try again',
};

export function SongSelection(props: {
  session: PlayerSession;
  roundIdx: number;
  countdownSeconds: () => number | null;
  /** Called once a submission is accepted (or already present) — parent flips to sealed. */
  onSealed: () => void;
}): JSX.Element {
  const [query, setQuery] = createSignal('');
  const [view, setView] = createSignal<SearchView>({ kind: 'idle' });
  const [selected, setSelected] = createSignal<Track | null>(null);
  const [sureArmed, setSureArmed] = createSignal(false);
  const [submitting, setSubmitting] = createSignal(false);
  const [submitError, setSubmitError] = createSignal<string | null>(null);

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
    const outcome: SearchOutcome = await searchTracks(q);
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
    const result = await submitTrack(props.session, track, props.roundIdx);
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
    <div class="p-screen p-select-screen">
      <header class="p-head p-select-head">
        <p class="p-round-tag">
          round {(props.roundIdx ?? 0) + 1}
          <Show when={props.countdownSeconds() !== null}>
            {' '}
            ·{' '}
            <span class="p-select-timer" role="timer">
              {props.countdownSeconds()}s
            </span>
          </Show>
        </p>
        <h1>PICK YOUR SONG</h1>
      </header>

      {/* Search pinned top — never fights the open keyboard. */}
      <div class="p-search-wrap">
        <span class="p-search-icon" aria-hidden="true">
          🔎
        </span>
        <input
          ref={searchInput}
          class="p-input p-search-input"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
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
            ✕
          </button>
        </Show>
      </div>

      {/* Results area sized to remaining viewport (dvh). */}
      <div class="p-results" aria-live="polite">
        <Show when={view()} keyed>
          {(v) => (
            <>
              <Show when={v.kind === 'idle'}>
                <div class="p-results-state">
                  <p class="p-sub">find the perfect answer…</p>
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
                      <span class="track-art p-skel-art" />
                      <span class="track-meta">
                        <span class="p-skel-line" />
                        <span class="p-skel-line p-skel-line-short" />
                      </span>
                    </div>
                  )}
                </For>
              </Show>

              {/* Search proxy not live yet (404): graceful disabled state, no error noise. */}
              <Show when={v.kind === 'unavailable'}>
                <div class="p-results-state">
                  <p class="p-sub">🔎 search is warming up…</p>
                  <p class="p-hint">the music library isn't connected yet — hang tight</p>
                </div>
              </Show>

              <Show when={v.kind === 'error'}>
                <div class="p-results-state">
                  <p class="p-error">{v.kind === 'error' ? v.message : ''}</p>
                </div>
              </Show>

              <Show when={v.kind === 'empty'}>
                <div class="p-results-state">
                  <p class="p-sub">nothing for “{query().trim()}”</p>
                  <p class="p-hint">try fewer words, or another spelling</p>
                </div>
              </Show>

              <Show when={v.kind === 'results'}>
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
        <div class="p-pick-bar">
          <div class="p-pick-info">
            <span class="p-pick-label">your pick</span>
            <Show when={selected()} keyed>
              {(t) => (
                <>
                  <span class="p-pick-title">{t.title}</span>
                  <span class="p-pick-artist">{t.artist}</span>
                </>
              )}
            </Show>
          </div>
          <button
            type="button"
            class="p-cta p-sure-btn"
            classList={{ 'p-sure-armed': sureArmed(), 'p-sure-busy': submitting() }}
            disabled={!selected() || submitting()}
            onClick={armOrConfirm}
          >
            {submitting() ? 'locking…' : sureArmed() ? 'SURE? 🔒' : 'LOCK IT IN'}
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
