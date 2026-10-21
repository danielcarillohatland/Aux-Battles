/**
 * Track card — one search result row. Shared so host pickers can reuse it.
 * Selection is an instant state swap.
 */
import { Show } from 'solid-js';
import type { JSX } from 'solid-js';
import type { Track } from '@aux/shared';
import './track-card.css';

function fmtDuration(ms?: number): string | null {
  if (!ms || ms <= 0) return null;
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

const SOURCE_LABEL: Record<NonNullable<Track['source']>, string> = {
  youtube: 'YouTube',
  deezer: 'Preview',
  apple_music: 'Apple Music',
  licensed: 'Licensed',
  original: 'AUX original',
  manual: 'Your pick',
};

export function TrackArt(props: { track: Track; size?: number; class?: string }) {
  const size = () => props.size ?? 44;
  return (
    <span
      class={`track-art${props.class ? ` ${props.class}` : ''}`}
      style={{ width: `${size()}px`, height: `${size()}px` }}
      aria-hidden="true"
    >
      <Show when={props.track.artUrl} fallback={<i />}>
        <img
          src={props.track.artUrl}
          alt=""
          loading="lazy"
          decoding="async"
          onError={(e) => {
            (e.currentTarget.parentElement as HTMLElement).classList.add('track-art--broken');
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
      classList={{ 'is-selected': props.selected === true }}
      onClick={() => props.onSelect?.(props.track)}
      aria-pressed={props.selected === true}
    >
      <TrackArt track={props.track} size={56} />
      <span class="track-meta">
        <span class="track-title">{props.track.title}</span>
        <span class="track-artist">
          {props.track.artist}
          <Show when={props.track.album}> · {props.track.album}</Show>
        </span>
        <Show when={props.track.description}>
          {(description) => <span class="track-description">{description()}</span>}
        </Show>
      </span>
      <span class="track-side">
        <Show when={duration()}>
          <span class="track-duration mono">{duration()}</span>
        </Show>
        <Show when={props.track.source}>
          {(source) => <span class="track-source">{SOURCE_LABEL[source()]}</span>}
        </Show>
      </span>
    </button>
  );
}
