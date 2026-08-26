/**
 * AUX BATTLES — host entry (host.html).
 * Landing → HostLobby switch; host session persisted in localStorage 'aux:host'
 * so a refresh reclaims the lobby instead of orphaning the room.
 */
import { createSignal, Show } from 'solid-js';
import { render } from 'solid-js/web';
import type { CreateRoomResponse } from '@aux/shared';
import '../shared-ui/shell.css';
import './host.css';
import { Landing } from './Landing.js';
import { HostLobby } from './HostLobby.js';

const STORAGE_KEY = 'aux:host';

function loadRoom(): CreateRoomResponse | null {
  try {
    // OAuth callback return: ?room=CODE pins the restored session to the room
    // the host was in when they left to authorize Spotify (server adds it).
    const url = new URL(window.location.href);
    const returnRoom = url.searchParams.get('room');
    if (returnRoom) {
      // Clean the URL so refreshes don't re-pin forever.
      url.searchParams.delete('room');
      window.history.replaceState({}, '', url.toString());
    }
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const room = JSON.parse(raw) as Partial<CreateRoomResponse>;
    // Returned for a DIFFERENT stored room: trust the URL, drop the stale one.
    if (returnRoom && room.code !== undefined && room.code !== returnRoom) {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    if (
      typeof room.code === 'string' &&
      typeof room.hostToken === 'string' &&
      typeof room.playerId === 'string'
    ) {
      return room as CreateRoomResponse;
    }
    localStorage.removeItem(STORAGE_KEY);
    return null;
  } catch {
    return null;
  }
}

const App = () => {
  const [room, setRoom] = createSignal<CreateRoomResponse | null>(loadRoom());

  const onCreated = (next: CreateRoomResponse) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    setRoom(next);
  };

  return (
    <Show when={room()} fallback={<Landing onCreated={onCreated} />} keyed>
      {(r) => <HostLobby room={r} />}
    </Show>
  );
};

render(() => <App />, document.getElementById('root') as HTMLElement);
