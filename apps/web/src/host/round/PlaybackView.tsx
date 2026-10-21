import { createEffect, createMemo, createSignal, on, onCleanup, Show } from 'solid-js';
import type { Snapshot, Track } from '@aux/shared';
import { apiUrl } from '../../config/endpoints.js';
import { embedSafeHostUrl, isIpAddressHost } from '../join-url.js';
import { playOriginalExcerpt, type OriginalExcerptController } from '../original-music.js';
import {
  fetchAppleMusicConfiguration,
  playAppleMusicTrack,
  type AppleMusicController,
} from '../apple-music.js';
import { fetchDeezerPreview } from '../deezer-music.js';
import {
  playYouTubeVideo,
  relayBase,
  youtubeCandidateIds,
  YouTubeUnavailableError,
  type YouTubeController,
} from '../youtube-player.js';

export interface PlaybackViewProps {
  roomCode: string;
  mode: Snapshot['playbackMode'];
  queue: Track[];
  currentIndex: number;
  playbackStatus: NonNullable<Snapshot['playbackStatus']>;
  playbackDevice: string | null;
  playbackError: string | null;
  excerptStartMs: number;
  excerptDurationMs: number;
  excerptStartedAt: number | null;
  hostToken: string;
  onAdvance: () => void;
}

/** Seconds the host card waits before skipping a song with no playable upload. */
export const AUTO_SKIP_SECONDS = 6;

export type CatalogPlaybackStatus =
  'idle' | 'loading' | 'playing' | 'paused' | 'complete' | 'failed';

export function shouldShowExcerptProgress(
  status: PlaybackViewProps['playbackStatus'],
  startedAt: number | null,
): boolean {
  return status === 'playing' && startedAt !== null;
}

export function playbackActionLabel(currentIndex: number, total: number): string {
  return total > 0 && currentIndex >= total - 1 ? 'Judge these songs' : 'Next song';
}

export function canAdvancePlayback(status: PlaybackViewProps['playbackStatus']): boolean {
  return status === 'complete' || status === 'failed';
}

/** Provider state must never trap a party on the current card. */
export function isPlaybackAdvanceDisabled(total: number): boolean {
  return total === 0;
}

export function manualMusicSearchUrl(
  track: Pick<Track, 'title' | 'artist'>,
  service: 'apple' | 'youtube',
): string {
  const terms = encodeURIComponent(`${track.title} ${track.artist}`);
  return service === 'apple'
    ? `https://music.apple.com/us/search?term=${terms}`
    : `https://www.youtube.com/results?search_query=${terms}`;
}

/** Sources that start on their own when their card comes up (Apple Music needs a sign-in tap). */
export function autoplaysCatalogTrack(source: Track['source']): boolean {
  return (
    source === 'youtube' || source === 'deezer' || source === 'licensed' || source === 'original'
  );
}

/** Browsers report blocked autoplay this way; the host then gets a Play button, not an error. */
export function isAutoplayBlocked(error: unknown): boolean {
  return (
    error instanceof Error && (error.name === 'NotAllowedError' || /autoplay/i.test(error.message))
  );
}

/**
 * Autoplaying sources hide the manual Play button unless the browser blocked the
 * start (idle + hint) or playback failed (Retry). Apple Music always shows it.
 */
export function showPlayButton(
  source: Track['source'],
  status: CatalogPlaybackStatus,
  error: string | null,
): boolean {
  if (status === 'failed') return true;
  if (status !== 'idle') return false;
  return !autoplaysCatalogTrack(source) || error !== null;
}

/** Sources whose audio the host browser plays through the shared <audio> element. */
export function usesAudioElement(source: Track['source']): boolean {
  return source === 'licensed' || source === 'deezer';
}

/** Provider page link shown beside provider-backed playback (attribution + manual recovery). */
export function providerLinkLabel(source: Track['source']): string | null {
  switch (source) {
    case 'apple_music':
      return 'Open in Apple Music';
    case 'deezer':
      return 'Open in Deezer';
    case 'youtube':
      return 'Open on YouTube';
    default:
      return null;
  }
}

/** Providers whose official player exposes pause/resume to the host card. */
export function hasProviderTransport(source: Track['source']): boolean {
  return source === 'apple_music' || source === 'youtube';
}

export function playCatalogButtonLabel(
  source: Track['source'],
  status: CatalogPlaybackStatus,
): string {
  if (status === 'failed') return 'Retry playback';
  switch (source) {
    case 'apple_music':
      return 'Play with Apple Music';
    case 'youtube':
      return 'Play on YouTube';
    case 'original':
      return 'Play AUX original';
    case 'deezer':
      return 'Play 30-second preview';
    default:
      return 'Play licensed highlight';
  }
}

export function catalogStatusCopy(source: Track['source'], status: CatalogPlaybackStatus): string {
  switch (status) {
    case 'idle':
      return source === 'apple_music'
        ? 'Ready to play from the Apple Music catalog'
        : source === 'youtube'
          ? 'Ready to play the official video from YouTube'
          : source === 'deezer'
            ? 'Ready to play a 30-second preview via Deezer'
            : 'Approved catalog track ready in the host browser';
    case 'loading':
      return source === 'apple_music'
        ? 'Connecting to Apple Music…'
        : source === 'youtube'
          ? 'Loading the YouTube player…'
          : source === 'original'
            ? 'Starting sample-free AUX synthesis…'
            : source === 'deezer'
              ? 'Fetching the Deezer preview…'
              : 'Loading licensed audio securely…';
    case 'playing':
      return source === 'apple_music'
        ? 'Playing through Apple Music'
        : source === 'youtube'
          ? 'Playing the highlight from YouTube'
          : source === 'original'
            ? 'Playing an AUX original—synthesized live'
            : source === 'deezer'
              ? 'Playing a 30-second preview via Deezer'
              : 'Playing a licensed AUX BATTLES highlight';
    case 'paused':
      return source === 'apple_music'
        ? 'Apple Music paused'
        : source === 'youtube'
          ? 'YouTube paused'
          : source === 'deezer'
            ? 'Preview paused'
            : 'Approved highlight paused';
    case 'complete':
      return 'Highlight complete · ready for judge review';
    case 'failed':
      return 'In-app playback needs attention';
  }
}

export const PlaybackView = (props: PlaybackViewProps) => {
  const [now, setNow] = createSignal(Date.now());
  const [catalogStatus, setCatalogStatus] = createSignal<CatalogPlaybackStatus>('idle');
  const [catalogElapsedMs, setCatalogElapsedMs] = createSignal(0);
  const [catalogError, setCatalogError] = createSignal<string | null>(null);
  let ticker: ReturnType<typeof setInterval> | undefined;
  let catalogTicker: ReturnType<typeof setInterval> | undefined;
  let catalogStartedAt: number | undefined;
  let originalPlayback: OriginalExcerptController | undefined;
  let appleMusicPlayback: AppleMusicController | undefined;
  let youtubePlayback: YouTubeController | undefined;
  let youtubeContainer: HTMLDivElement | undefined;
  let audioRef: HTMLAudioElement | undefined;
  let audioObjectUrl: string | undefined;
  let audioRequest: AbortController | undefined;

  const current = (): Track | undefined => props.queue[props.currentIndex];
  let autoSkip: ReturnType<typeof setTimeout> | undefined;

  /** After every candidate failed, continue to the next song unless the host already did. */
  const scheduleAutoSkip = (forIndex: number) => {
    if (autoSkip !== undefined) clearTimeout(autoSkip);
    autoSkip = setTimeout(() => {
      autoSkip = undefined;
      if (props.currentIndex === forIndex && props.mode === 'catalog') props.onAdvance();
    }, AUTO_SKIP_SECONDS * 1000);
  };

  const resetCatalogAudio = () => {
    if (autoSkip !== undefined) clearTimeout(autoSkip);
    autoSkip = undefined;
    originalPlayback?.stop();
    originalPlayback = undefined;
    appleMusicPlayback?.stop();
    appleMusicPlayback = undefined;
    youtubePlayback?.stop();
    youtubePlayback = undefined;
    audioRequest?.abort();
    audioRequest = undefined;
    audioRef?.pause();
    audioRef?.removeAttribute('src');
    audioRef?.load();
    if (audioObjectUrl !== undefined) URL.revokeObjectURL(audioObjectUrl);
    audioObjectUrl = undefined;
    if (catalogTicker !== undefined) clearInterval(catalogTicker);
    catalogTicker = undefined;
    catalogStartedAt = undefined;
    setCatalogStatus('idle');
    setCatalogElapsedMs(0);
    setCatalogError(null);
  };

  createEffect(() => {
    const playing = shouldShowExcerptProgress(props.playbackStatus, props.excerptStartedAt);
    if (ticker !== undefined) clearInterval(ticker);
    ticker = undefined;
    setNow(Date.now());
    if (playing) ticker = setInterval(() => setNow(Date.now()), 100);
  });
  // Only a genuine card change may restart playback. Snapshots arrive during
  // Listening for unrelated reasons (background judging, roster changes) and
  // replace the queue array; keying on this string keeps the video playing.
  const playbackKey = createMemo(
    () =>
      `${props.mode}|${props.currentIndex}|${current()?.id ?? ''}|${current()?.playbackUrl ?? ''}`,
  );
  createEffect(
    on(playbackKey, () => {
      // Card changes dispose the authenticated in-memory audio immediately,
      // then the next card starts on its own (the host already interacted to
      // reach playback, so browsers allow media to start).
      const index = props.currentIndex;
      resetCatalogAudio();
      const source = current()?.source;
      if (props.mode === 'catalog' && autoplaysCatalogTrack(source)) {
        queueMicrotask(() => {
          if (props.currentIndex === index && catalogStatus() === 'idle') void playCatalogTrack();
        });
      }
    }),
  );
  onCleanup(() => {
    if (ticker !== undefined) clearInterval(ticker);
    resetCatalogAudio();
  });

  const beginCatalogProgress = (elapsedMs = 0) => {
    catalogStartedAt = Date.now() - elapsedMs;
    if (catalogTicker !== undefined) clearInterval(catalogTicker);
    catalogTicker = setInterval(() => {
      if (catalogStartedAt === undefined) return;
      setCatalogElapsedMs(
        Math.min(props.excerptDurationMs, Math.max(0, Date.now() - catalogStartedAt)),
      );
    }, 100);
  };

  const pauseCatalogProgress = () => {
    if (catalogStartedAt !== undefined) {
      setCatalogElapsedMs(
        Math.min(props.excerptDurationMs, Math.max(0, Date.now() - catalogStartedAt)),
      );
    }
    if (catalogTicker !== undefined) clearInterval(catalogTicker);
    catalogTicker = undefined;
    catalogStartedAt = undefined;
  };

  const finishCatalogPlayback = () => {
    if (catalogTicker !== undefined) clearInterval(catalogTicker);
    catalogTicker = undefined;
    catalogStartedAt = undefined;
    setCatalogElapsedMs(props.excerptDurationMs);
    setCatalogStatus('complete');
  };

  const playCatalogTrack = async (): Promise<void> => {
    const track = current();
    const requestedIndex = props.currentIndex;
    if (props.mode !== 'catalog' || track === undefined) {
      setCatalogStatus('failed');
      setCatalogError('This approved track is not available for browser playback.');
      return;
    }
    resetCatalogAudio();
    setCatalogStatus('loading');
    setCatalogError(null);
    if (track.source === 'apple_music') {
      try {
        const config = await fetchAppleMusicConfiguration(props.roomCode, props.hostToken);
        appleMusicPlayback = await playAppleMusicTrack(
          config,
          track.id.slice('apple-music:'.length),
        );
        if (requestedIndex !== props.currentIndex) {
          appleMusicPlayback.stop();
          appleMusicPlayback = undefined;
          return;
        }
        setCatalogStatus('playing');
      } catch (error) {
        setCatalogStatus('failed');
        setCatalogError(error instanceof Error ? error.message : 'Apple Music could not play.');
      }
      return;
    }
    if (track.source === 'youtube') {
      const relayHost = new URL(relayBase()).hostname;
      if (isIpAddressHost(relayHost)) {
        // Every candidate would fail with error 150; say why instead of cycling.
        setCatalogStatus('failed');
        setCatalogError(
          `YouTube refuses to play when the game is opened by IP address (${relayHost}). Open the host screen at ${embedSafeHostUrl(window.location)} instead.`,
        );
        return;
      }
      const candidates = youtubeCandidateIds(track);
      const container = youtubeContainer;
      if (candidates.length === 0 || container === undefined) {
        setCatalogStatus('failed');
        setCatalogError('No embeddable video was found for this song.');
        return;
      }
      // Walk the ranked candidates: the API cannot prove a video plays inside
      // an iframe, so unavailable/embed-disabled/removed videos fall through to
      // the next one automatically. Only the host's browser can tell us.
      let lastFailure = '';
      for (const [attempt, videoId] of candidates.entries()) {
        if (requestedIndex !== props.currentIndex) return;
        setCatalogError(
          attempt === 0 ? null : `Upload ${attempt} was unavailable, trying another…`,
        );
        try {
          const controller = await playYouTubeVideo(
            container,
            videoId,
            props.excerptStartMs,
            props.excerptDurationMs,
            {
              onProgress: setCatalogElapsedMs,
              onComplete: () => setCatalogStatus('complete'),
              onPlaying: () => {
                // A late start after a blocked-autoplay hint must clear the hint.
                setCatalogError(null);
                setCatalogStatus('playing');
              },
              onPaused: () => setCatalogStatus('paused'),
              onError: (message) => {
                setCatalogStatus('failed');
                setCatalogError(message);
              },
            },
          );
          if (requestedIndex !== props.currentIndex) {
            controller.stop();
            return;
          }
          youtubePlayback = controller;
          setCatalogError(null);
          setCatalogStatus('playing');
          return;
        } catch (error) {
          if (isAutoplayBlocked(error)) {
            setCatalogStatus('idle');
            setCatalogError('Tap Play on YouTube to start the video.');
            return;
          }
          if (!(error instanceof YouTubeUnavailableError)) {
            setCatalogStatus('failed');
            setCatalogError(error instanceof Error ? error.message : 'YouTube could not play.');
            return;
          }
          // Unavailable: remember why and continue with the next candidate.
          lastFailure = error.message;
          if (import.meta.env.DEV)
            console.warn('[youtube] candidate failed', videoId, error.message);
        }
      }
      if (requestedIndex !== props.currentIndex) return;
      setCatalogStatus('failed');
      setCatalogError(
        `None of ${candidates.length} YouTube upload${candidates.length === 1 ? '' : 's'} would play here${lastFailure ? ` (last: ${lastFailure})` : ''}. Moving on in ${AUTO_SKIP_SECONDS}s…`,
      );
      scheduleAutoSkip(requestedIndex);
      return;
    }
    if (track.source === 'original') {
      try {
        originalPlayback = await playOriginalExcerpt(
          track.id,
          props.excerptStartMs,
          props.excerptDurationMs,
          finishCatalogPlayback,
        );
        if (requestedIndex !== props.currentIndex) {
          originalPlayback.stop();
          originalPlayback = undefined;
          return;
        }
        beginCatalogProgress();
        setCatalogStatus('playing');
      } catch (error) {
        setCatalogStatus('failed');
        setCatalogError(error instanceof Error ? error.message : 'Original music could not play.');
      }
      return;
    }

    // Licensed files and Deezer preview clips share the <audio> element. The
    // room-bound playbackUrl is host-authenticated; licensed audio arrives as an
    // in-memory blob, Deezer hands back a fresh short-lived CDN clip url.
    const playbackUrl = track.playbackUrl;
    const audio = audioRef;
    if (!usesAudioElement(track.source) || playbackUrl === undefined || audio === undefined) {
      setCatalogStatus('failed');
      setCatalogError('This track is not present in an approved playback catalog.');
      return;
    }
    const isPreview = track.source === 'deezer';
    audioRequest?.abort();
    const request = new AbortController();
    audioRequest = request;
    try {
      const src = isPreview
        ? (await fetchDeezerPreview(playbackUrl, props.hostToken, request.signal)).previewUrl
        : await fetchLicensedObjectUrl(playbackUrl, request.signal);
      if (
        request.signal.aborted ||
        requestedIndex !== props.currentIndex ||
        current()?.playbackUrl !== playbackUrl
      ) {
        if (!isPreview) URL.revokeObjectURL(src);
        return;
      }
      if (audioObjectUrl !== undefined) URL.revokeObjectURL(audioObjectUrl);
      audioObjectUrl = isPreview ? undefined : src;
      audio.src = src;
      audio.currentTime = props.excerptStartMs / 1000;
      await audio.play();
      beginCatalogProgress();
      setCatalogStatus('playing');
    } catch (error) {
      if (request.signal.aborted) return;
      if (isAutoplayBlocked(error)) {
        setCatalogStatus('idle');
        setCatalogError('Tap play to start the audio.');
        return;
      }
      setCatalogStatus('failed');
      setCatalogError(
        error instanceof Error
          ? error.message
          : isPreview
            ? 'The Deezer preview could not play.'
            : 'Licensed audio could not play.',
      );
    }
  };

  const fetchLicensedObjectUrl = async (playbackUrl: string, signal: AbortSignal) => {
    const response = await fetch(apiUrl(playbackUrl), {
      headers: { authorization: `Bearer ${props.hostToken}` },
      cache: 'no-store',
      signal,
    });
    if (!response.ok) throw new Error(`audio request failed (${response.status})`);
    return URL.createObjectURL(await response.blob());
  };

  const updateCatalogProgress = () => {
    if (audioRef === undefined) return;
    const startSeconds = props.excerptStartMs / 1000;
    const endSeconds = startSeconds + props.excerptDurationMs / 1000;
    if (audioRef.currentTime < startSeconds) audioRef.currentTime = startSeconds;
    const elapsed = Math.max(0, (audioRef.currentTime - startSeconds) * 1000);
    setCatalogElapsedMs(Math.min(props.excerptDurationMs, elapsed));
    if (audioRef.currentTime >= endSeconds || audioRef.ended) {
      audioRef.pause();
      finishCatalogPlayback();
    }
  };

  /** Pause/resume through the provider's official player (Apple Music, YouTube). */
  const toggleProviderPlayback = async () => {
    const transport = appleMusicPlayback ?? youtubePlayback;
    if (transport === undefined) return;
    if (catalogStatus() === 'playing') {
      transport.pause();
      setCatalogStatus('paused');
      return;
    }
    try {
      await transport.play();
      setCatalogStatus('playing');
    } catch (error) {
      setCatalogStatus('failed');
      setCatalogError(error instanceof Error ? error.message : 'Playback could not resume.');
    }
  };

  const elapsedMs = () =>
    props.excerptStartedAt === null
      ? 0
      : Math.min(props.excerptDurationMs, Math.max(0, now() - props.excerptStartedAt));
  const progress = () =>
    props.excerptDurationMs <= 0 ? 0 : Math.round((elapsedMs() / props.excerptDurationMs) * 100);
  const catalogProgress = () =>
    props.excerptDurationMs <= 0
      ? 0
      : Math.round((catalogElapsedMs() / props.excerptDurationMs) * 100);
  const statusCopy = () => {
    if (current()?.source === 'manual') {
      return 'Play this song in your music app, then continue below';
    }
    if (props.mode === 'catalog') return catalogStatusCopy(current()?.source, catalogStatus());
    switch (props.playbackStatus) {
      case 'ready':
        return `${props.queue.length} song${props.queue.length === 1 ? '' : 's'} ready`;
      case 'starting':
        return 'starting approved excerpt…';
      case 'playing':
        return `Playing AUX BATTLES excerpt${props.playbackDevice ? ` on ${props.playbackDevice}` : ''}`;
      case 'complete':
        return 'Excerpt complete';
      case 'failed':
        return 'playback unavailable · you can still continue';
    }
  };

  return (
    <section class="screen listening" aria-live="polite">
      <p class="kicker">
        Song <b>{Math.min(props.currentIndex + 1, props.queue.length)}</b> of {props.queue.length}
      </p>

      <Show when={props.mode === 'catalog'}>
        <div class="player-frame" data-source={current()?.source ?? 'none'}>
          {/* YouTube policy: the official player must stay visible and unobscured. */}
          <Show when={current()?.source === 'youtube'}>
            <div
              class="youtube-player"
              data-state={catalogStatus()}
              ref={youtubeContainer}
              aria-label="YouTube video player"
            />
          </Show>
          <Show when={current()?.source !== 'youtube' && current()?.artUrl}>
            {(art) => <img class="player-art" src={art()} alt="" />}
          </Show>
          <audio
            ref={audioRef}
            controls
            controlslist="nodownload noplaybackrate"
            preload="none"
            hidden={
              !usesAudioElement(current()?.source) ||
              catalogStatus() === 'idle' ||
              catalogStatus() === 'loading'
            }
            onLoadedMetadata={() => {
              if (audioRef !== undefined) audioRef.currentTime = props.excerptStartMs / 1000;
            }}
            onTimeUpdate={updateCatalogProgress}
            onSeeking={updateCatalogProgress}
            onPlay={() => {
              if (catalogStatus() === 'paused') beginCatalogProgress(catalogElapsedMs());
              setCatalogStatus('playing');
            }}
            onPause={() => {
              if (catalogStatus() === 'playing') {
                pauseCatalogProgress();
                setCatalogStatus('paused');
              }
            }}
            onEnded={updateCatalogProgress}
          />
        </div>
      </Show>

      <Show when={current()} keyed fallback={<p class="muted">Shuffling the deck…</p>}>
        {(track) => (
          <article class="now-playing" data-status={props.playbackStatus}>
            <Show when={props.mode !== 'catalog' && track.artUrl}>
              {(art) => <img class="now-playing-art" src={art()} alt="" />}
            </Show>
            <div class="now-playing-text">
              <h2 class="display now-playing-title">{track.title}</h2>
              <p class="now-playing-artist">{track.artist}</p>
              <Show when={track.description}>
                {(description) => <p class="muted">{description()}</p>}
              </Show>
            </div>
            <span class="tag now-playing-source">
              {track.source === 'youtube'
                ? 'YouTube'
                : track.source === 'deezer'
                  ? 'Deezer preview'
                  : track.source === 'apple_music'
                    ? 'Apple Music'
                    : track.source === 'licensed'
                      ? 'Licensed'
                      : track.source === 'original'
                        ? 'AUX original'
                        : 'Player pick'}
            </span>
          </article>
        )}
      </Show>

      <Show
        when={
          (props.mode === 'catalog' && current()?.source !== 'apple_music') ||
          shouldShowExcerptProgress(props.playbackStatus, props.excerptStartedAt)
        }
      >
        <div
          class="highlight"
          aria-label={`${Math.ceil(props.excerptDurationMs / 1000)} second highlight`}
        >
          <span class="highlight-bar">
            <i style={{ width: `${props.mode === 'catalog' ? catalogProgress() : progress()}%` }} />
          </span>
          <span class="highlight-time mono">
            {Math.floor((props.mode === 'catalog' ? catalogElapsedMs() : elapsedMs()) / 1000)}s
            <small> / {Math.ceil(props.excerptDurationMs / 1000)}s</small>
          </span>
        </div>
      </Show>

      <p class="listening-status muted" data-playback-status={props.playbackStatus}>
        {statusCopy()}
      </p>
      <Show when={catalogError()}>{(error) => <p class="listening-error">{error()}</p>}</Show>
      <Show
        when={props.mode !== 'catalog' && current()?.source !== 'manual' && props.playbackError}
      >
        {(error) => (
          <div class="notice notice--bad">
            <span>{error()}</span>
          </div>
        )}
      </Show>
      <Show
        when={props.mode !== 'catalog' && current()?.source === 'manual' && props.playbackError}
      >
        {(hint) => (
          <div class="notice notice--info">
            <span>{hint()}</span>
          </div>
        )}
      </Show>
      <Show when={current()?.source === 'manual' && current()} keyed>
        {(track) => (
          <div class="service-links" aria-label="Find this song in a music service">
            <a
              class="btn btn--ghost btn--small"
              href={manualMusicSearchUrl(track, 'apple')}
              target="_blank"
              rel="noreferrer"
            >
              Apple Music
            </a>
            <a
              class="btn btn--ghost btn--small"
              href={manualMusicSearchUrl(track, 'youtube')}
              target="_blank"
              rel="noreferrer"
            >
              YouTube
            </a>
          </div>
        )}
      </Show>

      <div class="stage-cta stage-cta--split listening-controls">
        <Show
          when={
            props.mode === 'catalog' &&
            showPlayButton(current()?.source, catalogStatus(), catalogError())
          }
        >
          <button type="button" class="btn btn--ghost" onClick={() => void playCatalogTrack()}>
            {playCatalogButtonLabel(current()?.source, catalogStatus())}
          </button>
        </Show>
        <Show
          when={
            props.mode === 'catalog' &&
            hasProviderTransport(current()?.source) &&
            (catalogStatus() === 'playing' || catalogStatus() === 'paused')
          }
        >
          <button
            type="button"
            class="btn btn--ghost"
            onClick={() => void toggleProviderPlayback()}
          >
            {catalogStatus() === 'playing' ? 'Pause' : 'Resume'}
          </button>
        </Show>
        <Show when={providerLinkLabel(current()?.source) !== null && current()?.externalUrl}>
          {(url) => (
            <a class="btn btn--ghost" href={url()} target="_blank" rel="noreferrer">
              {providerLinkLabel(current()?.source)}
            </a>
          )}
        </Show>
        <button
          type="button"
          class="btn btn--primary listening-next"
          disabled={isPlaybackAdvanceDisabled(props.queue.length)}
          onClick={() => {
            resetCatalogAudio();
            props.onAdvance();
          }}
        >
          {playbackActionLabel(props.currentIndex, props.queue.length)}
        </button>
      </div>
    </section>
  );
};
