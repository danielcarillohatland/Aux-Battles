/**
 * Host-side YouTube playback through the official IFrame Player API, hosted in
 * a relay page on the game's own http(s) origin (D-024, D-031).
 *
 * YouTube's developer policies require the player to stay visible (at least
 * 200×200, no overlays, no audio-only or background playback) and YouTube to be
 * named as the source. This module only drives the official player: it loads
 * the video at the excerpt start, watches the clock, and pauses at the end of
 * the highlight window.
 */

import { publicAppOrigin } from '../config/endpoints.js';
import { isIpAddressHost } from './join-url.js';

export const YOUTUBE_ID_PREFIX = 'youtube:';

/** The iframe refused this video (removed, private, embed-disabled, region-blocked). */
export class YouTubeUnavailableError extends Error {
  constructor(
    message: string,
    public readonly videoId: string,
  ) {
    super(message);
    this.name = 'YouTubeUnavailableError';
  }
}
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const AUTOPLAY_GUARD_MS = 9_000;

export interface YouTubeController {
  readonly isPlaying: boolean;
  play(): Promise<void>;
  pause(): void;
  stop(): void;
}

export interface YouTubePlaybackHandlers {
  /** Elapsed milliseconds inside the highlight window, clamped to its length. */
  onProgress(elapsedMs: number): void;
  onComplete(): void;
  onPlaying(): void;
  onPaused(): void;
  onError(message: string): void;
}

export function youtubeVideoIdOf(trackId: string): string | null {
  if (!trackId.startsWith(YOUTUBE_ID_PREFIX)) return null;
  const id = trackId.slice(YOUTUBE_ID_PREFIX.length);
  return VIDEO_ID.test(id) ? id : null;
}

/** Ordered, de-duplicated video ids to try for a track: primary first, then fallbacks. */
export function youtubeCandidateIds(track: {
  id: string;
  videoCandidates?: readonly string[] | undefined;
}): string[] {
  const primary = youtubeVideoIdOf(track.id);
  const ids = [...(primary === null ? [] : [primary]), ...(track.videoCandidates ?? [])];
  return ids.filter((id, index) => VIDEO_ID.test(id) && ids.indexOf(id) === index);
}

/** Player error codes from the IFrame API reference. */
export function youtubeErrorMessage(code: number): string {
  switch (code) {
    case 2:
      return `YouTube rejected this video id (error ${code}).`;
    case 5:
      return `The YouTube player could not start in this browser (error ${code}).`;
    case 100:
      return `This video was removed or made private on YouTube (error ${code}).`;
    case 101:
    case 150:
      return `YouTube will not play this video inside this page (error ${code}): the uploader blocks embedding, or the page was opened by IP address instead of a hostname.`;
    case 153:
      return `YouTube refused the embed because the page sent no referrer (error ${code}). Open the host page over http:// or https://, not from a file or app shell.`;
    default:
      return `YouTube could not play this video (error ${code}).`;
  }
}

/** Position inside the highlight window, in ms, clamped to [0, durationMs]. */
export function highlightElapsedMs(
  currentSeconds: number,
  excerptStartMs: number,
  excerptDurationMs: number,
): number {
  const elapsed = currentSeconds * 1000 - excerptStartMs;
  return Math.min(excerptDurationMs, Math.max(0, elapsed));
}

/** Errors that mean "this embed setup is broken", not "this video is bad". */
const SYSTEMIC_ERROR_CODES = new Set([5, 153]);

/** The embed itself failed for reasons unrelated to the specific video; trying more ids is pointless. */
export class YouTubeEmbedError extends Error {
  constructor(
    message: string,
    public readonly code: number,
  ) {
    super(message);
    this.name = 'YouTubeEmbedError';
  }
}

export function isSystemicYouTubeError(code: number): boolean {
  return SYSTEMIC_ERROR_CODES.has(code);
}

/** The YouTube player itself lives in a relay page served from an http(s) origin. */
const RELAY_TAG = 'aux-yt-relay';
const RELAY_PATH = '/yt-relay.html';
/** YouTube state codes reported by the relay. */
const STATE_ENDED = 0;
const STATE_PLAYING = 1;
const STATE_PAUSED = 2;

/**
 * Where the relay page is loaded from. YouTube needs the relay's parent to be
 * an http(s) origin with a hostname, so: the page's own origin when it is one
 * (web build, dev on localhost/.local); otherwise the configured public https
 * domain (native shells run from capacitor://localhost; in dev the public
 * origin is the LAN IP meant for phones and is only a last resort).
 */
export function relayBase(): string {
  return chooseRelayBase(window.location, publicAppOrigin());
}

export function chooseRelayBase(
  page: Pick<Location, 'protocol' | 'hostname' | 'origin'>,
  configured: string | null,
): string {
  const pageUsable = /^https?:$/.test(page.protocol) && !isIpAddressHost(page.hostname);
  if (pageUsable) return page.origin;
  if (configured !== null) {
    try {
      if (!isIpAddressHost(new URL(configured).hostname)) return configured;
    } catch {
      // fall through
    }
  }
  return configured ?? page.origin;
}

export function relayPlayerUrl(base: string, videoId: string, startSeconds: number): string {
  const url = new URL(RELAY_PATH, `${base.replace(/\/+$/, '')}/`);
  url.searchParams.set('v', videoId);
  url.searchParams.set('start', String(Math.max(0, Math.floor(startSeconds))));
  return url.toString();
}

type RelayMessage =
  | { aux: typeof RELAY_TAG; type: 'ready' }
  | { aux: typeof RELAY_TAG; type: 'state'; state: number }
  | { aux: typeof RELAY_TAG; type: 'time'; current: number }
  | { aux: typeof RELAY_TAG; type: 'error'; code: number };

function isRelayMessage(data: unknown): data is RelayMessage {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { aux?: unknown }).aux === RELAY_TAG &&
    typeof (data as { type?: unknown }).type === 'string'
  );
}

/**
 * Mount the relay inside `container` (which must stay visible) and start the
 * video at the excerpt window. Resolves once playback has begun (D-031).
 */
export async function playYouTubeVideo(
  container: HTMLElement,
  videoId: string,
  excerptStartMs: number,
  excerptDurationMs: number,
  handlers: YouTubePlaybackHandlers,
): Promise<YouTubeController> {
  if (!VIDEO_ID.test(videoId)) throw new Error('invalid YouTube video id');
  container.replaceChildren();
  const startSeconds = Math.floor(excerptStartMs / 1000);
  const endSeconds = (excerptStartMs + excerptDurationMs) / 1000;

  const iframe = document.createElement('iframe');
  iframe.src = relayPlayerUrl(relayBase(), videoId, startSeconds);
  const relayOrigin = new URL(iframe.src).origin;
  iframe.width = '100%';
  iframe.height = '100%';
  iframe.title = 'YouTube video player';
  iframe.setAttribute('frameborder', '0');
  iframe.setAttribute(
    'allow',
    'autoplay; encrypted-media; picture-in-picture; accelerometer; gyroscope; clipboard-write',
  );
  iframe.setAttribute('allowfullscreen', '');
  iframe.referrerPolicy = 'strict-origin-when-cross-origin';
  container.append(iframe);

  let playing = false;
  let finished = false;
  let listening = true;
  const send = (message: Record<string, unknown>) => {
    // Commands are addressed to the relay origin only.
    iframe.contentWindow?.postMessage({ ...message, aux: RELAY_TAG }, relayOrigin);
  };
  const finish = () => {
    if (finished) return;
    finished = true;
    playing = false;
    handlers.onProgress(excerptDurationMs);
    handlers.onComplete();
  };

  let onMessage: ((event: MessageEvent) => void) | undefined;
  const detach = () => {
    listening = false;
    if (onMessage !== undefined) window.removeEventListener('message', onMessage);
  };

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    // Only the player's own error events prove a video is unavailable. A video
    // that never starts is treated as blocked autoplay: the host gets a Play
    // button and the candidate is NOT discarded.
    const guard = setTimeout(() => {
      if (settled) return;
      settled = true;
      const error = new Error('autoplay blocked: press play to start the video');
      error.name = 'NotAllowedError';
      reject(error);
    }, AUTOPLAY_GUARD_MS);
    onMessage = (event: MessageEvent) => {
      // Only our own relay frame, served from the relay origin, may drive playback state.
      if (
        !listening ||
        event.source !== iframe.contentWindow ||
        event.origin !== relayOrigin ||
        !isRelayMessage(event.data)
      ) {
        return;
      }
      const message = event.data;
      if (message.type === 'state') {
        if (message.state === STATE_PLAYING) {
          playing = true;
          if (!settled) {
            settled = true;
            clearTimeout(guard);
            resolve();
          }
          handlers.onPlaying();
        } else if (message.state === STATE_PAUSED) {
          playing = false;
          if (!finished) handlers.onPaused();
        } else if (message.state === STATE_ENDED) {
          finish();
        }
      } else if (message.type === 'time') {
        if (finished) return;
        handlers.onProgress(highlightElapsedMs(message.current, excerptStartMs, excerptDurationMs));
        if (message.current >= endSeconds) {
          send({ cmd: 'pause' });
          finish();
        }
      } else if (message.type === 'error') {
        const code = Number(message.code);
        const text = youtubeErrorMessage(code);
        playing = false;
        const error = isSystemicYouTubeError(code)
          ? new YouTubeEmbedError(text, code)
          : new YouTubeUnavailableError(text, videoId);
        if (!settled) {
          settled = true;
          clearTimeout(guard);
          reject(error);
        } else {
          handlers.onError(text);
        }
      }
    };
    window.addEventListener('message', onMessage);
  }).catch((error: unknown) => {
    detach();
    container.replaceChildren();
    throw error;
  });

  return {
    get isPlaying() {
      return playing;
    },
    async play() {
      if (finished) {
        finished = false;
        send({ cmd: 'seek', seconds: startSeconds });
      }
      send({ cmd: 'play' });
    },
    pause() {
      send({ cmd: 'pause' });
    },
    stop() {
      playing = false;
      finished = true;
      detach();
      send({ cmd: 'stop' });
      container.replaceChildren();
    },
  };
}
