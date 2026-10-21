import { describe, expect, it } from 'vitest';
import { apiUrl, webSocketUrl } from '../src/config/endpoints.js';

describe('native endpoint resolution', () => {
  it('keeps relative URLs for the same-origin web build', () => {
    expect(apiUrl('/api/v1/rooms', null)).toBe('/api/v1/rooms');
  });

  it('targets the deployed backend for native REST and WebSocket traffic', () => {
    expect(apiUrl('/api/v1/rooms', 'https://aux-battles.fly.dev/')).toBe(
      'https://aux-battles.fly.dev/api/v1/rooms',
    );
    expect(webSocketUrl('/ws?room=ABCDE', 'https://aux-battles.fly.dev')).toBe(
      'wss://aux-battles.fly.dev/ws?room=ABCDE',
    );
  });

  it('does not rewrite already absolute audio URLs', () => {
    expect(apiUrl('https://cdn.example/audio.mp3', 'https://aux-battles.fly.dev')).toBe(
      'https://cdn.example/audio.mp3',
    );
  });
});
