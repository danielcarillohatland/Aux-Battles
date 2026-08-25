/**
 * AUX BATTLES — Host Manual Playback card (D-E: manual mode is FIRST-CLASS).
 * The product's insurance policy, not an apology screen: when the room runs
 * `playback_mode: manual`, the host drives every track from this card —
 * big swipeable song cards, one giant Next button, progress dots, and a
 * ⏸ round-clock-paused indicator (the round timer holds between tracks).
 *
 * Strictly presentational (owner condition #10: zero animation delays —
 * no entrance keyframes, no transitions anywhere in here): all state comes
 * in through props and advancing is delegated upward (REST per D-D).
 */
import { createEffect, For, Show } from 'solid-js';
import type { PlaybackMode, Track } from '@aux/shared';

export interface ManualPlaybackProps {
  /** This round's queue, in play order. */
  queue: Track[];
  /** Index of the track currently up. */
  currentIndex: number;
  /** Host tapped Next — the parent advances the round. */
  onAdvance: () => void;
  /** Mode badge value; the host reads it from the snapshot (D-E). Defaults to 'manual'. */
  playbackMode?: PlaybackMode | undefined;
}

export const ManualPlayback = (props: ManualPlaybackProps) => {
  const total = () => props.queue.length;

  const clampedIndex = () => Math.min(Math.max(props.currentIndex, 0), Math.max(total() - 1, 0));

  const currentTrack = (): Track | undefined => props.queue[clampedIndex()];

  /** Last card already up — Next has nowhere to go within this round. */
  const atEnd = () => total() === 0 || props.currentIndex >= total() - 1;

  // Keep the active card centered in the swipe strip. Instant scroll —
  // animations may never delay gameplay (owner condition #10).
  let stripRef: HTMLDivElement | undefined;
  const cardRefs: HTMLDivElement[] = [];
  createEffect(() => {
    const card = cardRefs[clampedIndex()];
    card?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'instant' });
  });

  return (
    <section class="manual-card" aria-label="Manual playback">
      <div class="manual-head">
        <h2 class="manual-heading">manual playback</h2>
        <span class="mode-badge" data-mode={props.playbackMode ?? 'manual'}>
          {props.playbackMode ?? 'manual'}
        </span>
      </div>

      {/* D-E: the round clock pauses between tracks while the host drives. */}
      <Show when={(props.playbackMode ?? 'manual') === 'manual'}>
        <p class="manual-paused" role="status">
          ⏸ round clock paused
        </p>
      </Show>

      <Show
        when={currentTrack()}
        fallback={<p class="manual-empty">Waiting for this round's tracks…</p>}
      >
        <div class="manual-strip" ref={stripRef}>
          <For each={props.queue}>
            {(track, i) => (
              <div
                ref={(el) => (cardRefs[i()] = el)}
                classList={{ 'manual-track': true, active: i() === clampedIndex() }}
                data-track-index={i()}
              >
                <span class="manual-track-num">#{i() + 1}</span>
                <p class="manual-title">{track.title}</p>
                <p class="manual-artist">{track.artist}</p>
                <Show when={track.album}>
                  <p class="manual-album">{track.album}</p>
                </Show>
              </div>
            )}
          </For>
        </div>

        <div class="manual-progress" aria-label={`Track ${clampedIndex() + 1} of ${total()}`}>
          <div class="manual-dots" role="presentation">
            <For each={props.queue}>
              {(_, i) => <span classList={{ dot: true, on: i() === clampedIndex() }} />}
            </For>
          </div>
          <span class="manual-count">
            {clampedIndex() + 1}/{total()}
          </span>
        </div>

        <button
          type="button"
          class="btn-primary btn-manual-next"
          disabled={atEnd()}
          onClick={() => props.onAdvance()}
        >
          {atEnd() ? 'Round done ✓' : 'Next ▶'}
        </button>
      </Show>
    </section>
  );
};
