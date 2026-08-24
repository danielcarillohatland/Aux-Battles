/**
 * AUX BATTLES — Landing (host entry, frontend-spec §2.1).
 * One job: create a room fast. Zero animation delays (owner condition #10) —
 * the button responds on press, no entrance choreography.
 */
import { createSignal, Show } from 'solid-js';
import type { CreateRoomResponse } from '@aux/shared';
import { apiRequest, HostApiError } from './api.js';
import { errorText } from './errors.js';

interface LandingProps {
  onCreated: (room: CreateRoomResponse) => void;
}

export const Landing = (props: LandingProps) => {
  const [busy, setBusy] = createSignal(false);
  const [errorCode, setErrorCode] = createSignal<ReturnType<typeof errorText> | null>(null);

  const createRoom = async () => {
    if (busy()) return;
    setBusy(true);
    setErrorCode(null);
    try {
      const room = await apiRequest<CreateRoomResponse>('/api/v1/rooms', { method: 'POST' });
      props.onCreated(room);
    } catch (err) {
      const code = err instanceof HostApiError ? err.code : 'INTERNAL';
      setErrorCode(errorText(code));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main class="stage">
      <h1 class="wordmark">
        AUX <span class="blades">⚔</span> BATTLES
      </h1>
      <p class="tagline">One category. One song. One winner.</p>

      <button type="button" class="btn-primary btn-create" disabled={busy()} onClick={createRoom}>
        {busy() ? 'Creating…' : 'Create Room'}
      </button>

      <Show when={errorCode()}>
        {(msg) => (
          <div class="banner banner-error" role="alert">
            <span>{msg()}</span>
            <button type="button" class="btn-retry" onClick={createRoom}>
              Retry
            </button>
          </div>
        )}
      </Show>

      <footer class="how-it-works">
        How it works: ① Create a room · ② Friends scan the QR · ③ Best aux wins.
      </footer>
    </main>
  );
};
