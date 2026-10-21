import { describe, expect, it } from 'vitest';
import {
  chooseRelayBase,
  highlightElapsedMs,
  isSystemicYouTubeError,
  relayPlayerUrl,
  youtubeErrorMessage,
  youtubeVideoIdOf,
} from '../src/host/youtube-player.js';

describe('host YouTube playback helpers', () => {
  it('extracts the video id only from well-formed youtube track ids', () => {
    expect(youtubeVideoIdOf('youtube:FGBhQbmPwH8')).toBe('FGBhQbmPwH8');
    expect(youtubeVideoIdOf('youtube:FGBhQbmPwH8"><script>')).toBeNull();
    expect(youtubeVideoIdOf('deezer:FGBhQbmPwH8')).toBeNull();
  });

  it('clamps the highlight clock to the excerpt window', () => {
    expect(highlightElapsedMs(60, 60_000, 30_000)).toBe(0);
    expect(highlightElapsedMs(75.5, 60_000, 30_000)).toBe(15_500);
    expect(highlightElapsedMs(120, 60_000, 30_000)).toBe(30_000);
    expect(highlightElapsedMs(10, 60_000, 30_000)).toBe(0);
  });

  it('picks a hostname origin for the relay: page first, configured domain for native shells', () => {
    const web = {
      protocol: 'http:',
      hostname: 'daniels-macbook-air.local',
      origin: 'http://daniels-macbook-air.local:5173',
    };
    expect(chooseRelayBase(web, 'http://192.168.0.122:5173')).toBe(web.origin);
    const native = {
      protocol: 'capacitor:',
      hostname: 'localhost',
      origin: 'capacitor://localhost',
    };
    expect(chooseRelayBase(native, 'https://aux-battles.fly.dev')).toBe(
      'https://aux-battles.fly.dev',
    );
    const ipPage = {
      protocol: 'http:',
      hostname: '192.168.0.122',
      origin: 'http://192.168.0.122:5173',
    };
    expect(chooseRelayBase(ipPage, 'https://aux-battles.fly.dev')).toBe(
      'https://aux-battles.fly.dev',
    );
    expect(chooseRelayBase(ipPage, 'http://192.168.0.122:5173')).toBe('http://192.168.0.122:5173');
    expect(chooseRelayBase(ipPage, null)).toBe(ipPage.origin);
  });

  it('builds the relay url on the given origin so native shells use the https domain', () => {
    expect(relayPlayerUrl('https://aux-battles.fly.dev', 'FGBhQbmPwH8', 77.9)).toBe(
      'https://aux-battles.fly.dev/yt-relay.html?v=FGBhQbmPwH8&start=77',
    );
    expect(relayPlayerUrl('http://localhost:5173/', 'FGBhQbmPwH8', 0)).toBe(
      'http://localhost:5173/yt-relay.html?v=FGBhQbmPwH8&start=0',
    );
  });

  it('separates broken-embed errors from bad-video errors', () => {
    expect(isSystemicYouTubeError(153)).toBe(true);
    expect(isSystemicYouTubeError(5)).toBe(true);
    expect(isSystemicYouTubeError(150)).toBe(false);
    expect(isSystemicYouTubeError(100)).toBe(false);
  });

  it('explains embed refusals in host-readable copy', () => {
    expect(youtubeErrorMessage(150)).toMatch(/error 150.*IP address/);
    expect(youtubeErrorMessage(101)).toMatch(/embedding/);
    expect(youtubeErrorMessage(100)).toMatch(/removed or made private/);
    expect(youtubeErrorMessage(153)).toMatch(/referrer/);
    expect(youtubeErrorMessage(999)).toMatch(/could not play this video \(error 999\)/);
  });
});

describe('candidate fallback list', () => {
  it('orders the primary video first and drops duplicates and junk', async () => {
    const { youtubeCandidateIds, YouTubeUnavailableError } =
      await import('../src/host/youtube-player.js');
    expect(
      youtubeCandidateIds({
        id: 'youtube:FGBhQbmPwH8',
        videoCandidates: ['FGBhQbmPwH8', 'coverkaraok', 'bad id', 'J7p4bzqLvCw'],
      }),
    ).toEqual(['FGBhQbmPwH8', 'coverkaraok', 'J7p4bzqLvCw']);
    expect(youtubeCandidateIds({ id: 'deezer:1' })).toEqual([]);
    const error = new YouTubeUnavailableError('gone', 'FGBhQbmPwH8');
    expect(error.name).toBe('YouTubeUnavailableError');
    expect(error.videoId).toBe('FGBhQbmPwH8');
  });
});
