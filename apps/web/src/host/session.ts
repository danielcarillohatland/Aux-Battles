import type { CreateRoomResponse } from '@aux/shared';
import { apiRequest, HostApiError } from './api.js';
import { accountHeaders } from '../billing/session.js';

export const HOST_STORAGE_KEY = 'aux:host';

type HostStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

interface SessionDeps {
  storage?: HostStorage;
  history?: Pick<History, 'replaceState'>;
  href?: string;
}

interface FreshRoomDeps extends SessionDeps {
  request?: typeof apiRequest;
}

export type HostRestoreResult =
  | { status: 'none' }
  | { status: 'valid'; room: CreateRoomResponse; ticket: string }
  | { status: 'unavailable'; room: CreateRoomResponse; reason: string };

function browserDeps(deps: SessionDeps) {
  return {
    storage: deps.storage ?? localStorage,
    history: deps.history ?? window.history,
    href: deps.href ?? window.location.href,
  };
}

function cleanRoomQuery(history: Pick<History, 'replaceState'>, href: string) {
  const url = new URL(href);
  if (!url.searchParams.has('room')) return;
  url.searchParams.delete('room');
  history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
}

/** Remove only room-scoped host identity. Durable preferences stay intact. */
export function clearHostRoomSession(deps: SessionDeps = {}): void {
  const { storage, history, href } = browserDeps(deps);
  storage.removeItem(HOST_STORAGE_KEY);
  cleanRoomQuery(history, href);
}

/** Parse the persisted host identity and consume an OAuth return-room query. */
export function loadPersistedHostRoom(deps: SessionDeps = {}): CreateRoomResponse | null {
  const { storage, history, href } = browserDeps(deps);
  const url = new URL(href);
  const returnRoom = url.searchParams.get('room');
  cleanRoomQuery(history, href);

  try {
    const raw = storage.getItem(HOST_STORAGE_KEY);
    if (!raw) return null;
    const room = JSON.parse(raw) as Partial<CreateRoomResponse>;
    if (returnRoom && room.code !== returnRoom) {
      storage.removeItem(HOST_STORAGE_KEY);
      return null;
    }
    if (
      typeof room.code === 'string' &&
      typeof room.hostToken === 'string' &&
      typeof room.playerId === 'string'
    ) {
      return room as CreateRoomResponse;
    }
  } catch {
    // Corrupt browser state is equivalent to no resumable room.
  }
  storage.removeItem(HOST_STORAGE_KEY);
  return null;
}

/**
 * Validate a persisted room/token before mounting the lobby. The returned
 * one-time ticket is handed directly to realtime, so validation is also the
 * first half of the actual WebSocket handshake.
 */
export async function restorePersistedHostRoom(
  deps: FreshRoomDeps = {},
): Promise<HostRestoreResult> {
  const room = loadPersistedHostRoom(deps);
  if (room === null) return { status: 'none' };

  const request = deps.request ?? apiRequest;
  try {
    const { ticket } = await request<{ ticket: string }>('/api/v1/ws-ticket', {
      method: 'POST',
      headers: { authorization: `Bearer ${room.hostToken}` },
      body: JSON.stringify({ code: room.code }),
    });
    return { status: 'valid', room, ticket };
  } catch (err) {
    if (
      err instanceof HostApiError &&
      (err.code === 'NOT_AUTHENTICATED' ||
        err.code === 'ROOM_NOT_FOUND' ||
        err.code === 'ROOM_CLOSED' ||
        err.code === 'INVALID_CODE')
    ) {
      clearHostRoomSession(deps);
      return { status: 'none' };
    }
    return {
      status: 'unavailable',
      room,
      reason: err instanceof HostApiError ? err.message : 'Could not reach the server.',
    };
  }
}

/** Create and persist a genuinely new host identity after a complete reset. */
export async function createFreshHostRoom(deps: FreshRoomDeps = {}): Promise<CreateRoomResponse> {
  const request = deps.request ?? apiRequest;
  const { storage } = browserDeps(deps);

  // Clear before POST so a failed create or dev-server restart cannot remount
  // the old lobby, socket, token, or OAuth return-room state.
  clearHostRoomSession(deps);
  const headers = accountHeaders();
  const room = await request<CreateRoomResponse>('/api/v1/rooms', {
    method: 'POST',
    ...(Object.keys(headers).length ? { headers } : {}),
  });

  storage.setItem(HOST_STORAGE_KEY, JSON.stringify(room));
  return room;
}
