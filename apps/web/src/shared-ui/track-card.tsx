/**
 * Track card — one search result row (frontend-spec §2.6).
 * Shared so host-side pickers can reuse the same card later.
 * Zero animation delays: selection highlight is an instant background swap.
 */
import { Show } from 'solid-js';
import type { JSX } from 'solid-js';
import type { Track } from '@aux/shared';
import './track-card.css';

const FALLBACK_ART = '🎵';

function fmtDuration(ms?: number): string | null {
  if (!ms || ms <= 0) return null;
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function TrackArt(props: { track: Track; size?: number; class?: string }) {
  const size = () => props.size ?? 44;
  return (
    <span
      class={`track-art${props.class ? ` ${props.class}` : ''}`}
      style={{ width: `${size()}px`, height: `${size()}px` }}
      aria-hidden="true"
    >
      <Show when={props.track.artUrl} fallback={FALLBACK_ART}>
        <img
          src={props.track.artUrl}
          alt=""
          loading="lazy"
          decoding="async"
          onError={(e) => {
            // Dead art URL → collapse to the emoji fallback, never a broken image.
            (e.currentTarget.parentElement as HTMLElement).classList.add('track-art-broken');
            e.currentTarget.remove();
          }}
        />
      </Show>
    </span>
  );
}

export function TrackCard(props: {
  track: Track;
  selected?: boolean;
  onSelect?: (track: Track) => void;
}): JSX.Element {
  const duration = () => fmtDuration(props.track.durationMs);
  return (
    <button
      type="button"
      class="track-card"
      classList={{ 'track-card-selected': props.selected === true }}
      onClick={() => props.onSelect?.(props.track)}
      aria-pressed={props.selected === true}
    >
      <TrackArt track={props.track} />
      <span class="track-meta">
        <span class="track-title">{props.track.title}</span>
        <span class="track-artist">
          {props.track.artist}
          <Show when={props.track.album}> · {props.track.album}</Show>
        </span>
      </span>
      <Show when={duration()}>
        <span class="track-duration">{duration()}</span>
      </Show>
    </button>
  );
}
