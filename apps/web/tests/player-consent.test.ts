import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchRoomJudgeMode, joinRoom } from '../src/player/api.js';

const response = (data: unknown) =>
  new Response(JSON.stringify({ ok: true, data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
afterEach(() => vi.unstubAllGlobals());

describe('player AI consent', () => {
  it('never sends consent by default or when explicitly declined', async () => {
    const fetch = vi
      .fn()
      .mockImplementation(() => Promise.resolve(response({ playerId: 'p', playerToken: 't' })));
    vi.stubGlobal('fetch', fetch);
    await joinRoom('ABCDE', 'DJ');
    await joinRoom('ABCDE', 'DJ', false);
    for (const [, options] of fetch.mock.calls) {
      expect(JSON.parse(options.body)).not.toHaveProperty('aiConsent');
    }
  });

  it('sends explicit consent when the player has agreed', async () => {
    const fetch = vi.fn().mockResolvedValue(response({ playerId: 'p', playerToken: 't' }));
    vi.stubGlobal('fetch', fetch);
    await joinRoom('ABCDE', 'DJ', true);
    expect(JSON.parse(fetch.mock.calls[0]![1].body).aiConsent).toBe(true);
  });

  it('only recognizes explicit AI or crowd modes from the server', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response({ judgingMode: 'ai' }))
      .mockResolvedValueOnce(response({ judgingMode: 'crowd' }))
      .mockResolvedValueOnce(response({ judgingMode: 'unknown' }))
      .mockResolvedValueOnce(response({}));
    vi.stubGlobal('fetch', fetch);
    expect(await fetchRoomJudgeMode('ABCDE')).toBe('ai');
    expect(await fetchRoomJudgeMode('ABCDE')).toBe('crowd');
    expect(await fetchRoomJudgeMode('ABCDE')).toBeNull();
    expect(await fetchRoomJudgeMode('ABCDE')).toBeNull();
  });

  it('keeps an unavailable mode unknown after a failed request', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    expect(await fetchRoomJudgeMode('ABCDE')).toBeNull();
  });
});
