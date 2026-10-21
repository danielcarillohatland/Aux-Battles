import { requestWithDeadline } from '../config/request.js';
import { createEffect, createSignal, For, onCleanup, Show } from 'solid-js';
import type { Snapshot } from '@aux/shared';
import { apiUrl } from '../config/endpoints.js';
import { TrackArt } from '../shared-ui/track-card.js';
import { VibeLine } from '../shared-ui/vibe-line.js';

/** The ballot is server-owned. Reconnecting restores whether this player has voted. */
export function CrowdVote(props: {
  snapshot: Snapshot;
  playerToken?: string;
  busy?: boolean;
  onClose?: () => void;
}) {
  const [selected, setSelected] = createSignal<string | null>(null);
  const [sending, setSending] = createSignal(false);
  const [sentBallot, setSentBallot] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [now, setNow] = createSignal(Date.now());
  const timer = setInterval(() => setNow(Date.now()), 1_000);
  onCleanup(() => clearInterval(timer));
  const ballot = () => props.snapshot.crowdVote;
  const host = () => props.snapshot.you.role === 'host';
  const voted = () => ballot()?.voted || sentBallot() === ballot()?.ballotId;
  const remaining = () => Math.max(0, Math.ceil(((ballot()?.closesAt ?? now()) - now()) / 1_000));
  let currentBallot: string | undefined;
  createEffect(() => {
    const id = ballot()?.ballotId;
    if (id === currentBallot) return;
    currentBallot = id;
    setSelected(null);
    setSentBallot(null);
    setError(null);
  });

  const submit = async () => {
    const current = ballot();
    const optionId = selected();
    if (!current || !props.playerToken || !optionId || sending() || voted() || !current.eligible)
      return;
    setSending(true);
    setError(null);
    try {
      const response = await requestWithDeadline(
        apiUrl(`/api/v1/rooms/${encodeURIComponent(props.snapshot.roomCode)}/crowd-vote`),
        {
          method: 'POST',

          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${props.playerToken}`,
          },
          body: JSON.stringify({ ballotId: current.ballotId, optionId }),
        },
      );
      const body = (await response.json()) as { ok?: boolean };
      if (!response.ok || body.ok !== true) throw new Error('vote_rejected');
      setSentBallot(current.ballotId);
    } catch {
      setError('Your vote was not confirmed. Try again while voting is open.');
    } finally {
      setSending(false);
    }
  };

  return (
    <section class={host() ? 'screen crowd-vote' : 'p-screen crowd-vote'}>
      <h1 class="display">The room decides.</h1>
      <Show when={props.snapshot.judgeNotice}>
        {(notice) => (
          <p class="crowd-vote-notice" role="status">
            {notice() === 'off_duty'
              ? 'DJ AUX is off duty for today, so the room decides.'
              : 'DJ AUX couldn’t make it this round, so the room decides.'}
          </p>
        )}
      </Show>
      <Show when={ballot()} fallback={<p role="status">Opening the vote…</p>}>
        {(current) => (
          <>
            <p>{host() ? 'Vote on your phones for the best fit.' : props.snapshot.scenario}</p>
            <VibeLine vibe={props.snapshot.scenarioVibe} />
            <div class="crowd-vote-count" role="status">
              {current().received} / {current().eligibleCount} votes · {remaining()}s
            </div>
            <Show when={!host()}>
              <Show
                when={current().eligible}
                fallback={<p>Watch the main screen for the result.</p>}
              >
                <Show
                  when={!voted()}
                  fallback={
                    <p class="crowd-vote-confirmed" role="status">
                      Vote locked. Watch the main screen.
                    </p>
                  }
                >
                  <p>Pick the best song. Your own pick is left out.</p>
                  <div class="crowd-vote-options" role="group" aria-label="Choose your vote">
                    <For each={current().options}>
                      {(option) => (
                        <button
                          class="track-card"
                          type="button"
                          classList={{ 'is-selected': selected() === option.id }}
                          aria-pressed={selected() === option.id}
                          disabled={sending() || remaining() === 0}
                          onClick={() => setSelected(option.id)}
                        >
                          <TrackArt track={option.track} size={52} />
                          <span class="track-meta">
                            <strong class="track-title">{option.track.title}</strong>
                            <span class="track-artist">{option.track.artist}</span>
                          </span>
                          <span aria-hidden="true">{selected() === option.id ? '✓' : '○'}</span>
                        </button>
                      )}
                    </For>
                  </div>
                  <Show when={error()}>
                    {(message) => (
                      <p class="p-error" role="alert">
                        {message()}
                      </p>
                    )}
                  </Show>
                  <button
                    type="button"
                    class="btn btn--primary btn--block"
                    disabled={!selected() || sending() || remaining() === 0}
                    onClick={() => void submit()}
                  >
                    {sending() ? 'Sending…' : 'Lock my vote'}
                  </button>
                </Show>
              </Show>
            </Show>
            <details class="crowd-vote-policy">
              <summary>How voting works</summary>
              <p>One anonymous vote per player. Votes cannot be changed. {current().tiePolicy}</p>
            </details>
            <Show when={host()}>
              <button
                class="btn btn--primary crowd-vote-close"
                type="button"
                disabled={props.busy || (!current().canClose && remaining() > 0)}
                onClick={props.onClose}
              >
                Show the result
              </button>
            </Show>
          </>
        )}
      </Show>
    </section>
  );
}
