/** AUX BATTLES — the invitation to the listening party. */
import { createSignal, Show } from 'solid-js';
import type { CreateRoomResponse } from '@aux/shared';
import { apiRequest, HostApiError } from './api.js';
import { errorText } from './errors.js';
import { enableGameMusic } from './game-music.js';
import HostAccountPanel from '../shared-ui/HostAccountPanel.js';
import { AppInfo } from '../shared-ui/AppInfo.js';
import { accountHeaders, createRoomBody } from '../billing/session.js';

interface LandingProps {
  onCreated: (room: CreateRoomResponse) => void;
}

export const Landing = (props: LandingProps) => {
  const [busy, setBusy] = createSignal(false);
  const [errorCode, setErrorCode] = createSignal<ReturnType<typeof errorText> | null>(null);

  const createRoom = async () => {
    if (busy()) return;
    // Prime audio while this trusted tap still owns autoplay permission.
    enableGameMusic();
    setBusy(true);
    setErrorCode(null);
    try {
      const body = createRoomBody();
      const room = await apiRequest<CreateRoomResponse>('/api/v1/rooms', {
        method: 'POST',
        headers: accountHeaders(),
        ...(body !== undefined ? { body } : {}),
      });
      props.onCreated(room);
    } catch (err) {
      const code = err instanceof HostApiError ? err.code : 'INTERNAL';
      setErrorCode(errorText(code));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main class="landing">
      <header class="landing-nav">
        <a class="brand" href="/host.html" aria-label="AUX Battles home">
          <span class="brand-record" aria-hidden="true" />
          AUX<span class="brand-slash">/</span>BATTLES
        </a>
        <nav aria-label="Main navigation">
          <a class="landing-how-link" href="#how-to-play">
            How to play
          </a>
          <a class="landing-join-link" href="/player.html">
            Join a room <span aria-hidden="true">↗</span>
          </a>
        </nav>
      </header>

      <section class="landing-main" aria-labelledby="landing-title">
        <div class="landing-copy rise">
          <h1 class="display landing-title" id="landing-title">
            Pass
            <br />
            <em>the aux.</em>
          </h1>
          <p class="landing-description">Pick a song. Defend your taste. Take the room.</p>
          <div class="landing-actions">
            <button
              type="button"
              class="btn btn--primary btn--big"
              disabled={busy()}
              onClick={createRoom}
            >
              {busy() ? 'Opening the room…' : 'Host a game'}
              <span aria-hidden="true">↗</span>
            </button>
            <a class="btn btn--ghost btn--big" href="/player.html">
              Join a room
            </a>
          </div>
          <p class="landing-fine">A music game for one shared screen and everyone’s phones.</p>
          <HostAccountPanel />
          <Show when={errorCode()}>
            {(msg) => (
              <div class="notice notice--bad" role="alert">
                <span>{msg()}</span>
                <button type="button" class="btn btn--small" disabled={busy()} onClick={createRoom}>
                  Try again
                </button>
              </div>
            )}
          </Show>
        </div>

        <div
          class="landing-art"
          role="img"
          aria-label="Example scenario: the song for walking away from an explosion"
        >
          <div class="record-sleeve" aria-hidden="true">
            <span class="sleeve-label">THE AUX COLLECTION / 001</span>
            <div class="hero-record">
              <div class="record-label">
                <span>AUX</span>
                <small>SIDE A · 33⅓ RPM</small>
                <i />
              </div>
            </div>
            <span class="sleeve-corner">33⅓</span>
          </div>
          <div class="scenario-sample">
            <div class="sample-meta">
              <span>Tonight’s first track</span>
              <span aria-hidden="true">↗</span>
            </div>
            <p>The song for walking away from an explosion.</p>
            <div class="sample-bottom">
              <span>Your song goes here.</span>
              <span class="sample-wave" aria-hidden="true">
                <i />
                <i />
                <i />
                <i />
                <i />
              </span>
            </div>
          </div>
          <span class="sleeve-sticker" aria-hidden="true">
            Good
            <br />
            taste?
          </span>
        </div>
      </section>

      <section class="landing-how" id="how-to-play" aria-labelledby="how-title">
        <div class="landing-section-head">
          <h2 id="how-title">How to play</h2>
        </div>
        <ol class="landing-steps">
          <li>
            <span class="step-number">01</span>
            <div>
              <h3>Set the scene</h3>
              <p>Open a room. Friends scan the code. You choose the scenario.</p>
            </div>
          </li>
          <li>
            <span class="step-number">02</span>
            <div>
              <h3>Make your pick</h3>
              <p>Find the song that fits. Lock it in and make your case.</p>
            </div>
          </li>
          <li>
            <span class="step-number">03</span>
            <div>
              <h3>Face the judge</h3>
              <p>Listen together. Get the verdict. Argue about it.</p>
            </div>
          </li>
        </ol>
      </section>
      <footer class="landing-footer">
        <span>AUX/BATTLES</span>
        <a href="/player.html">Join your friends ↗</a>
      </footer>
      <AppInfo />
    </main>
  );
};
