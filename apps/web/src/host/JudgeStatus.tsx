import { createSignal, onCleanup, onMount, Show } from 'solid-js';
import { apiRequest } from './api.js';
import '../shared-ui/judge-status.css';

interface JudgeAvailability {
  state: 'offline' | 'configured' | 'ready' | 'degraded';
  message: string;
}

const LABELS = {
  offline: 'Crowd judging',
  configured: 'AI judge',
  ready: 'AI judge',
  degraded: 'Crowd backup',
} as const;

/** Configuration and recent request health only; refreshing never calls a paid model. */
export function JudgeStatus(props: { code: string; hostToken: string }) {
  const [status, setStatus] = createSignal<JudgeAvailability | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  let disposed = false;
  const refresh = async () => {
    if (busy()) return;
    setBusy(true);
    try {
      const result = await apiRequest<JudgeAvailability>(
        `/api/v1/rooms/${encodeURIComponent(props.code)}/judge/status`,
        { headers: { authorization: `Bearer ${props.hostToken}` } },
      );
      if (!disposed) {
        setStatus(result);
        setFailed(false);
      }
    } catch {
      if (!disposed) setFailed(true);
    } finally {
      if (!disposed) setBusy(false);
    }
  };
  onMount(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 30_000);
    onCleanup(() => clearInterval(timer));
  });
  onCleanup(() => {
    disposed = true;
  });

  return (
    <aside
      class="judge-availability"
      data-state={failed() ? 'unknown' : status()?.state}
      aria-label="Judge availability"
    >
      <span class="judge-availability__dot" aria-hidden="true" />
      <div class="judge-availability__copy" aria-live="polite">
        <strong>
          {failed()
            ? 'Judge status unavailable'
            : status()
              ? LABELS[status()!.state]
              : 'Checking the judge…'}
        </strong>
        <Show when={failed() || status()?.state === 'degraded'}>
          <p>
            {failed() ? 'Could not check. Try again.' : 'Players vote if the AI is unavailable.'}
          </p>
        </Show>
      </div>
      <button
        class="btn btn--ghost btn--small"
        type="button"
        disabled={busy()}
        onClick={() => void refresh()}
        aria-label="Refresh judge status"
      >
        {busy() ? 'Checking…' : 'Refresh'}
      </button>
    </aside>
  );
}
