import { describe, expect, it, vi } from 'vitest';
import type { CreateRoomResponse } from '@aux/shared';
import { HostApiError } from '../src/host/api.js';
import {
  createFreshHostRoom,
  HOST_STORAGE_KEY,
  restorePersistedHostRoom,
} from '../src/host/session.js';
import { GAME_OVER_CONFETTI_MS, startConfettiLifecycle } from '../src/host/confetti.js';

describe('host replay lifecycle', () => {
  it('Play Again clears the old identity before creating and persisting a fresh room', async () => {
    const fresh: CreateRoomResponse = {
      code: 'FRESH',
      hostToken: 'new-host-token',
      playerId: 'new-player-id',
    };
    const order: string[] = [];
    const request = vi.fn(async () => {
      order.push('request');
      return fresh;
    });
    const storage = {
      getItem: vi.fn(),
      setItem: vi.fn(() => order.push('persist')),
      removeItem: vi.fn(() => order.push('clear')),
    };
    const history = { replaceState: vi.fn() };

    const result = await createFreshHostRoom({
      request: request as never,
      storage,
      history,
      href: 'http://192.168.0.122:5173/host.html?room=STALE',
    });

    expect(result).toEqual(fresh);
    expect(request).toHaveBeenCalledWith('/api/v1/rooms', { method: 'POST' });
    expect(order).toEqual(['clear', 'request', 'persist']);
    expect(storage.removeItem).toHaveBeenCalledWith(HOST_STORAGE_KEY);
    expect(storage.setItem).toHaveBeenCalledWith(HOST_STORAGE_KEY, JSON.stringify(fresh));
    expect(history.replaceState).toHaveBeenCalledWith({}, '', '/host.html');
  });

  it.each([
    ['stale room 404', 'ROOM_NOT_FOUND'],
    ['invalid host token', 'NOT_AUTHENTICATED'],
    ['room lost after a dev-server restart', 'ROOM_CLOSED'],
  ] as const)('clears persisted state for %s', async (_label, code) => {
    const stale: CreateRoomResponse = {
      code: 'STALE',
      hostToken: 'old-host-token',
      playerId: 'old-player-id',
    };
    const storage = {
      getItem: vi.fn(() => JSON.stringify(stale)),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };
    const request = vi.fn().mockRejectedValue(new HostApiError(code, 'gone'));

    const result = await restorePersistedHostRoom({
      request: request as never,
      storage,
      history: { replaceState: vi.fn() },
      href: 'http://127.0.0.1:8787/host.html',
    });

    expect(result).toEqual({ status: 'none' });
    expect(storage.removeItem).toHaveBeenCalledWith(HOST_STORAGE_KEY);
  });

  it('restores a valid host and carries its validation ticket into realtime', async () => {
    const saved: CreateRoomResponse = {
      code: 'ALIVE',
      hostToken: 'valid-host-token',
      playerId: 'valid-player-id',
    };
    const storage = {
      getItem: vi.fn(() => JSON.stringify(saved)),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };
    const request = vi.fn().mockResolvedValue({ ticket: 'validated-ticket' });

    const result = await restorePersistedHostRoom({
      request: request as never,
      storage,
      history: { replaceState: vi.fn() },
      href: 'http://192.168.0.122:5173/host.html',
    });

    expect(result).toEqual({ status: 'valid', room: saved, ticket: 'validated-ticket' });
    expect(storage.removeItem).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith('/api/v1/ws-ticket', {
      method: 'POST',
      headers: { authorization: 'Bearer valid-host-token' },
      body: JSON.stringify({ code: 'ALIVE' }),
    });
  });

  it('keeps a valid identity during a temporary server outage so Retry can recover it', async () => {
    const saved: CreateRoomResponse = {
      code: 'ALIVE',
      hostToken: 'valid-host-token',
      playerId: 'valid-player-id',
    };
    const storage = {
      getItem: vi.fn(() => JSON.stringify(saved)),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };

    const result = await restorePersistedHostRoom({
      request: vi.fn().mockRejectedValue(new HostApiError('NETWORK', 'offline')) as never,
      storage,
      history: { replaceState: vi.fn() },
      href: 'http://127.0.0.1:8787/host.html',
    });

    expect(result).toEqual({ status: 'unavailable', room: saved, reason: 'offline' });
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  it('removes confetti after its lifecycle and cancels cleanly on early unmount', () => {
    vi.useFakeTimers();
    const hide = vi.fn();
    const stop = startConfettiLifecycle(hide);
    vi.advanceTimersByTime(GAME_OVER_CONFETTI_MS - 1);
    expect(hide).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(hide).toHaveBeenCalledOnce();

    const earlyHide = vi.fn();
    const stopEarly = startConfettiLifecycle(earlyHide);
    stopEarly();
    vi.advanceTimersByTime(GAME_OVER_CONFETTI_MS);
    expect(earlyHide).not.toHaveBeenCalled();
    stop();
    vi.useRealTimers();
  });

  it('invokes injected timer methods through their owning object', () => {
    const owner = {
      timer: 17 as unknown as ReturnType<typeof setTimeout>,
      set(this: unknown, callback: () => void) {
        expect(this).toBe(owner);
        callback();
        return this.timer;
      },
      clear(this: unknown, timer: ReturnType<typeof setTimeout>) {
        expect(this).toBe(owner);
        expect(timer).toBe(this.timer);
      },
    };
    const hide = vi.fn();
    const stop = startConfettiLifecycle(hide, 1, owner);
    expect(hide).toHaveBeenCalledOnce();
    stop();
  });
});
