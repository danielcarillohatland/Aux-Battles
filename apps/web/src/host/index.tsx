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
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const room = JSON.parse(raw) as Partial<CreateRoomResponse>;
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
