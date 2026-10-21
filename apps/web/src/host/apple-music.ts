import { apiUrl } from '../config/endpoints.js';

interface MusicKitInstance {
  readonly isAuthorized: boolean;
  readonly isPlaying: boolean;
  readonly currentPlaybackTime: number;
  authorize(): Promise<string | void>;
  setQueue(options: { song: string }): Promise<unknown>;
  play(): Promise<void> | void;
  pause(): void;
  stop(): Promise<void> | void;
}

interface MusicKitGlobal {
  configure(options: {
    developerToken: string;
    storefrontId: string;
    app: { name: string; build: string };
  }): Promise<MusicKitInstance> | MusicKitInstance;
  getInstance(): MusicKitInstance;
}

declare global {
  interface Window {
    MusicKit?: MusicKitGlobal;
  }
}

export interface AppleMusicConfiguration {
  developerToken: string;
  storefront: string;
}

export interface AppleMusicController {
  readonly isPlaying: boolean;
  readonly currentTimeMs: number;
  play(): Promise<void>;
  pause(): void;
  stop(): void;
}

let scriptPromise: Promise<MusicKitGlobal> | undefined;
let configuredToken: string | undefined;

function loadMusicKit(): Promise<MusicKitGlobal> {
  if (window.MusicKit !== undefined) return Promise.resolve(window.MusicKit);
  if (scriptPromise !== undefined) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://js-cdn.music.apple.com/musickit/v3/musickit.js';
    script.async = true;
    script.onload = () => {
      if (window.MusicKit === undefined) reject(new Error('MusicKit did not initialize'));
      else resolve(window.MusicKit);
    };
    script.onerror = () => reject(new Error('MusicKit could not be loaded'));
    document.head.append(script);
  });
  return scriptPromise;
}

async function instanceFor(config: AppleMusicConfiguration): Promise<MusicKitInstance> {
  const MusicKit = await loadMusicKit();
  if (configuredToken !== config.developerToken) {
    await MusicKit.configure({
      developerToken: config.developerToken,
      storefrontId: config.storefront,
      app: { name: 'AUX BATTLES', build: '0.1.0' },
    });
    configuredToken = config.developerToken;
  }
  return MusicKit.getInstance();
}

export async function fetchAppleMusicConfiguration(
  roomCode: string,
  hostToken: string,
): Promise<AppleMusicConfiguration> {
  const response = await fetch(
    apiUrl(`/api/v1/rooms/${encodeURIComponent(roomCode)}/apple-music/config`),
    {
      headers: { authorization: `Bearer ${hostToken}`, accept: 'application/json' },
      cache: 'no-store',
    },
  );
  if (!response.ok) throw new Error('Apple Music is not configured for this room');
  const body = (await response.json()) as {
    ok?: unknown;
    data?: { developerToken?: unknown; storefront?: unknown };
  };
  const token = body.data?.developerToken;
  const storefront = body.data?.storefront;
  if (body.ok !== true || typeof token !== 'string' || typeof storefront !== 'string') {
    throw new Error('Apple Music configuration is invalid');
  }
  return { developerToken: token, storefront };
}

export async function playAppleMusicTrack(
  config: AppleMusicConfiguration,
  trackId: string,
): Promise<AppleMusicController> {
  const music = await instanceFor(config);
  if (!music.isAuthorized) {
    const authorized = await music.authorize();
    if (authorized === undefined && !music.isAuthorized) {
      throw new Error('Sign in with an Apple Music subscription to play this song');
    }
  }
  await music.setQueue({ song: trackId });
  await music.play();
  return {
    get isPlaying() {
      return music.isPlaying;
    },
    get currentTimeMs() {
      return Math.max(0, music.currentPlaybackTime * 1000);
    },
    async play() {
      await music.play();
    },
    pause() {
      music.pause();
    },
    stop() {
      void music.stop();
    },
  };
}
