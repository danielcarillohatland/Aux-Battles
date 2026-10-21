/**
 * AUX BATTLES — host entry (host.html).
 * Landing → validated restore → HostLobby. A persisted identity never mounts
 * realtime until the server has confirmed that both room and host token live.
 */
import { createSignal, Match, onMount, Show, Switch } from 'solid-js';
import { render } from 'solid-js/web';
import type { CreateRoomResponse } from '@aux/shared';
import '../shared-ui/shell.css';
import './host.css';
import { Landing } from './Landing.js';
import { HostLobby } from './HostLobby.js';
import {
  clearHostRoomSession,
  createFreshHostRoom,
  HOST_STORAGE_KEY,
  restorePersistedHostRoom,
} from './session.js';

type StartupState = 'checking' | 'ready' | 'unavailable';

const App = () => {
  const [room, setRoom] = createSignal<CreateRoomResponse | null>(null);
  const [initialTicket, setInitialTicket] = createSignal<string | undefined>();
  const [startup, setStartup] = createSignal<StartupState>('checking');
  const [startupIssue, setStartupIssue] = createSignal('Could not reach the server.');
  let operation = 0;

  const restore = async () => {
    const current = ++operation;
    setStartup('checking');
    const result = await restorePersistedHostRoom();
    if (current !== operation) return;
    if (result.status === 'valid') {
      setInitialTicket(result.ticket);
      setRoom(result.room);
      setStartup('ready');
      return;
    }
    setRoom(null);
    if (result.status === 'unavailable') {
      setStartupIssue(result.reason);
      setStartup('unavailable');
    } else {
      setStartup('ready');
    }
  };

  onMount(() => void restore());

  const onCreated = (next: CreateRoomResponse) => {
    localStorage.setItem(HOST_STORAGE_KEY, JSON.stringify(next));
    setInitialTicket(undefined);
    setRoom(next);
    setStartup('ready');
  };

  const clearAndReturnToLanding = () => {
    operation += 1;
    // Unmounting keyed HostLobby synchronously closes its socket and timers.
    setRoom(null);
    setInitialTicket(undefined);
    clearHostRoomSession();
    setStartup('ready');
  };

  const createNewRoom = async () => {
    operation += 1;
    setRoom(null);
    setInitialTicket(undefined);
    setStartup('checking');
    try {
      const next = await createFreshHostRoom();
      setRoom(next);
      setStartup('ready');
    } catch (err) {
      setStartupIssue(err instanceof Error ? err.message : 'Could not create room.');
      setStartup('unavailable');
    }
  };

  return (
    <Switch>
      <Match when={startup() === 'checking'}>
        <main class="stage recovery" aria-live="polite">
          <span class="thinking-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <p class="muted">Checking host session…</p>
        </main>
      </Match>
      <Match when={startup() === 'unavailable'}>
        <main class="stage recovery">
          <div class="notice notice--bad" role="alert">
            <span>Host session could not be checked. {startupIssue()}</span>
            <button type="button" class="btn btn--small" onClick={() => void restore()}>
              Retry
            </button>
            <button
              type="button"
              class="btn btn--small btn--primary"
              onClick={() => void createNewRoom()}
            >
              New room
            </button>
          </div>
        </main>
      </Match>
      <Match when={true}>
        <Show when={room()} fallback={<Landing onCreated={onCreated} />} keyed>
          {(r) => (
            <HostLobby
              room={r}
              initialTicket={initialTicket()}
              onPlayAgain={createNewRoom}
              onSessionInvalid={clearAndReturnToLanding}
            />
          )}
        </Show>
      </Match>
    </Switch>
  );
};

render(() => <App />, document.getElementById('root') as HTMLElement);
