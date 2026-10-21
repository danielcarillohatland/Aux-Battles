import { describe, expect, it } from 'vitest';
import {
  autoplaysCatalogTrack,
  canAdvancePlayback,
  catalogStatusCopy,
  hasProviderTransport,
  isAutoplayBlocked,
  isPlaybackAdvanceDisabled,
  showPlayButton,
  manualMusicSearchUrl,
  playbackActionLabel,
  playCatalogButtonLabel,
  providerLinkLabel,
  shouldShowExcerptProgress,
  usesAudioElement,
} from '../src/host/round/PlaybackView.js';

describe('host playback card state', () => {
  it('shows progress only after verified playback has a start timestamp', () => {
    expect(shouldShowExcerptProgress('ready', null)).toBe(false);
    expect(shouldShowExcerptProgress('starting', null)).toBe(false);
    expect(shouldShowExcerptProgress('playing', null)).toBe(false);
    expect(shouldShowExcerptProgress('playing', 123)).toBe(true);
    expect(shouldShowExcerptProgress('complete', null)).toBe(false);
    expect(shouldShowExcerptProgress('failed', null)).toBe(false);
  });

  it('uses Next song until the final card, then Judge', () => {
    expect(playbackActionLabel(0, 3)).toBe('Next song');
    expect(playbackActionLabel(1, 3)).toBe('Next song');
    expect(playbackActionLabel(2, 3)).toBe('Judge these songs');
    expect(playbackActionLabel(0, 1)).toBe('Judge these songs');
  });

  it('waits for the full highlight or a recoverable playback failure before advancing', () => {
    expect(canAdvancePlayback('ready')).toBe(false);
    expect(canAdvancePlayback('starting')).toBe(false);
    expect(canAdvancePlayback('playing')).toBe(false);
    expect(canAdvancePlayback('complete')).toBe(true);
    expect(canAdvancePlayback('failed')).toBe(true);
  });

  it('never provider-gates Next song when a queue exists', () => {
    expect(isPlaybackAdvanceDisabled(0)).toBe(true);
    expect(isPlaybackAdvanceDisabled(1)).toBe(false);
    expect(isPlaybackAdvanceDisabled(3)).toBe(false);
  });

  it('plays licensed files and Deezer clips through the shared audio element only', () => {
    expect(usesAudioElement('licensed')).toBe(true);
    expect(usesAudioElement('deezer')).toBe(true);
    expect(usesAudioElement('apple_music')).toBe(false);
    expect(usesAudioElement('youtube')).toBe(false);
    expect(usesAudioElement('original')).toBe(false);
    expect(usesAudioElement('manual')).toBe(false);
    expect(usesAudioElement(undefined)).toBe(false);
  });

  it('autoplays every in-browser source except Apple Music and treats blocked autoplay softly', () => {
    expect(autoplaysCatalogTrack('youtube')).toBe(true);
    expect(autoplaysCatalogTrack('deezer')).toBe(true);
    expect(autoplaysCatalogTrack('licensed')).toBe(true);
    expect(autoplaysCatalogTrack('apple_music')).toBe(false);
    expect(autoplaysCatalogTrack('manual')).toBe(false);
    const blocked = new Error('play() failed');
    blocked.name = 'NotAllowedError';
    expect(isAutoplayBlocked(blocked)).toBe(true);
    expect(isAutoplayBlocked(new Error('autoplay blocked: press play'))).toBe(true);
    expect(isAutoplayBlocked(new Error('network down'))).toBe(false);
  });

  it('hides the redundant Play button for autoplaying sources unless blocked or failed', () => {
    expect(showPlayButton('youtube', 'idle', null)).toBe(false);
    expect(showPlayButton('youtube', 'idle', 'Tap Play on YouTube to start the video.')).toBe(true);
    expect(showPlayButton('youtube', 'failed', 'nope')).toBe(true);
    expect(showPlayButton('youtube', 'playing', null)).toBe(false);
    expect(showPlayButton('apple_music', 'idle', null)).toBe(true);
    expect(showPlayButton('deezer', 'idle', null)).toBe(false);
  });

  it('labels provider links and play buttons per source', () => {
    expect(providerLinkLabel('deezer')).toBe('Open in Deezer');
    expect(providerLinkLabel('apple_music')).toBe('Open in Apple Music');
    expect(providerLinkLabel('youtube')).toBe('Open on YouTube');
    expect(providerLinkLabel('licensed')).toBeNull();
    expect(playCatalogButtonLabel('youtube', 'idle')).toBe('Play on YouTube');
    expect(hasProviderTransport('youtube')).toBe(true);
    expect(hasProviderTransport('apple_music')).toBe(true);
    expect(hasProviderTransport('deezer')).toBe(false);
    expect(playCatalogButtonLabel('deezer', 'idle')).toBe('Play 30-second preview');
    expect(playCatalogButtonLabel('deezer', 'failed')).toBe('Retry playback');
    expect(playCatalogButtonLabel('licensed', 'idle')).toBe('Play licensed highlight');
  });

  it('describes Deezer preview playback in every catalog state', () => {
    expect(catalogStatusCopy('deezer', 'idle')).toContain('Deezer');
    expect(catalogStatusCopy('deezer', 'loading')).toContain('Deezer');
    expect(catalogStatusCopy('deezer', 'playing')).toContain('30-second preview');
    expect(catalogStatusCopy('deezer', 'paused')).toBe('Preview paused');
    expect(catalogStatusCopy('youtube', 'idle')).toContain('YouTube');
    expect(catalogStatusCopy('youtube', 'playing')).toContain('YouTube');
    expect(catalogStatusCopy('youtube', 'paused')).toBe('YouTube paused');
    expect(catalogStatusCopy('licensed', 'playing')).toContain('licensed');
    expect(catalogStatusCopy('apple_music', 'complete')).toContain('Highlight complete');
  });

  it('builds safe service searches for a player-entered song', () => {
    const track = { title: 'Dreams & Nightmares', artist: 'Meek Mill' };
    expect(manualMusicSearchUrl(track, 'apple')).toBe(
      'https://music.apple.com/us/search?term=Dreams%20%26%20Nightmares%20Meek%20Mill',
    );
    expect(manualMusicSearchUrl(track, 'youtube')).toBe(
      'https://www.youtube.com/results?search_query=Dreams%20%26%20Nightmares%20Meek%20Mill',
    );
  });
});
