/**
 * AUX BATTLES — host round flow, PLAYBACK step (D-E: both modes first-class).
 *
 *  - mode `api`: now-playing card with an elapsed progress bar. The bar runs
 *    locally from the moment the current track went up (the round clock is
 *    paused in PLAYBACK — it ends on QUEUE_DONE / host taps, not a deadline).
 *  - mode `manual` / `silent`: mount the existing ManualPlayback card fed the
 *    round queue; advancing flows up through onManualAdvance (REST per D-D).
 *
 * The authoritative queue and index arrive in the room snapshot; an empty
 * queue still renders a truthful waiting state during synchronization.
 */
import { createEffect, createSignal, onCleanup, onMount, Show } from 'solid-js';
import type { Track } from '@aux/shared';
import { ManualPlayback } from '../manual-playback.js';

export interface PlaybackViewProps {
  mode: 'api' | 'manual' | 'silent';
  /** This round's queue, in play order (may be briefly empty while syncing). */
  queue: Track[];
  /** Index of the track currently up in the queue mirror. */
  currentIndex: number;
  onManualAdvance: () => void;
}

const TICK_MS = 500;

export const PlaybackView = (props: PlaybackViewProps) => {
  // ── API-mode local elapsed clock ───────────────────────────────────────────
  const [elapsedMs, setElapsedMs] = createSignal(0);
  let ticker: ReturnType<typeof setInterval> | undefined;
  const resetClock = () => setElapsedMs(0);
  onMount(() => {
    ticker = setInterval(() => setElapsedMs((ms) => ms + TICK_MS), TICK_MS);
  });
  onCleanup(() => {
    if (ticker !== undefined) clearInterval(ticker);
  });
  // New track up → the clock restarts.
  createEffect(() => {
    void props.currentIndex;
    resetClock();
  });

  const current = (): Track | undefined => props.queue[props.currentIndex];
  /** Progress within the current track, clamped — we don't poll provider state yet. */
  const pct = () => {
    const t = current();
    if (t?.durationMs === undefined || t.durationMs <= 0) return 0;
    return Math.min(100, Math.round((elapsedMs() / t.durationMs) * 100));
  };

  return (
    <Show
      when={props.mode !== 'api'}
      fallback={
        <div class="round-card now-playing" role="status">
          <h2 class="round-heading">now playing</h2>
          <Show
            when={current()}
            fallback={<p class="hint">waiting for the round queue to sync…</p>}
          >
            {(t) => (
              <>
                <p class="np-title">{t().title}</p>
                <p class="np-artist">{t().artist}</p>
                <div class="progress-bar np-bar" aria-hidden="true">
                  <div class="progress-fill" style={{ width: `${pct()}%` }} />
                </div>
                <p class="hint">
                  track {props.currentIndex + 1}/{props.queue.length} · api autoplay
                </p>
              </>
            )}
          </Show>
        </div>
      }
    >
      {/* manual / silent: the existing host-driven card, fed the round queue */}
      <ManualPlayback
        queue={props.queue}
        currentIndex={props.currentIndex}
        onAdvance={props.onManualAdvance}
        playbackMode={props.mode}
      />
    </Show>
  );
};
