/**
 * AUX BATTLES — Host Lobby (the "door", frontend-spec §2.2).
 * Giant code + QR to join + live player count via 2 s snapshot polling.
 * Polling failures never dead-end: last-known roster stays up under an amber
 * retry banner. Zero animation delays (owner condition #10).
 */
import { createSignal, createEffect, onCleanup, onMount, For, Show } from 'solid-js';
import QRCode from 'qrcode';
import type { Snapshot } from '@aux/shared';
import { apiRequest, HostApiError } from './api.js';
import { errorText } from './errors.js';

const POLL_INTERVAL_MS = 2000;

interface HostLobbyProps {
  room: { code: string; hostToken: string; playerId: string };
}

export const HostLobby = (props: HostLobbyProps) => {
  const [players, setPlayers] = createSignal<string[]>([]);
  const [pollError, setPollError] = createSignal(false);
  const [fatal, setFatal] = createSignal<string | null>(null);
  let canvasRef: HTMLCanvasElement | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  const joinUrl = `${location.origin}/player.html?code=${props.room.code}`;

  const poll = async () => {
    try {
      const snap = await apiRequest<Snapshot>(
        `/api/v1/rooms/${encodeURIComponent(props.room.code)}/snapshot`,
        { headers: { authorization: `Bearer ${props.room.hostToken}` } },
      );
      setPlayers(snap.players.map((p) => p.nickname));
      setPollError(false);
    } catch (err) {
      // Room gone (expired/closed): stop polling, offer a way back — no dead UI.
      if (
        err instanceof HostApiError &&
        (err.code === 'ROOM_NOT_FOUND' || err.code === 'ROOM_CLOSED')
      ) {
        setFatal(errorText(err.code));
        if (timer !== undefined) clearInterval(timer);
        return;
      }
      setPollError(true); // transient — keep roster visible, banner offers manual retry
    }
  };

  onMount(() => {
    void poll();
    timer = setInterval(() => void poll(), POLL_INTERVAL_MS);
  });
  onCleanup(() => {
    if (timer !== undefined) clearInterval(timer);
  });

  // Render QR once the canvas exists; re-render only if the URL changes.
  createEffect(() => {
    const canvas = canvasRef;
    if (!canvas) return;
    void QRCode.toCanvas(canvas, joinUrl, {
      width: Math.min(420, Math.floor(window.innerHeight * 0.5)),
      margin: 1,
      color: { dark: '#0e0b16', light: '#ffffff' },
    });
  });

  return (
    <main class="stage lobby">
      <Show
        when={!fatal()}
        fallback={
          <div class="banner banner-error" role="alert">
            <span>{fatal()}</span>
            <a class="btn-retry" href="/host.html">
              New room
            </a>
          </div>
        }
      >
        <p class="lobby-label">ROOM CODE</p>
        <div
          class="room-code"
          title="Tap to copy"
          onClick={() => void navigator.clipboard?.writeText(props.room.code)}
        >
          {props.room.code}
        </div>

        <div class="qr-panel">
          <canvas ref={canvasRef} aria-label={`QR code joining ${joinUrl}`} />
          <p class="join-url">{joinUrl}</p>
        </div>

        <Show when={pollError()}>
          <div class="banner banner-warn" role="status">
            <span>Shaky connection… holding on 🤞</span>
            <button type="button" class="btn-retry" onClick={() => void poll()}>
              Retry now
            </button>
          </div>
        </Show>

        <section class="roster">
          <h2>players joined: {players().length}</h2>
          <Show
            when={players().length > 0}
            fallback={<p class="empty-roster">Nobody yet — share the QR! ↖</p>}
          >
            <ul>
              <For each={players()}>{(nick) => <li>{nick}</li>}</For>
            </ul>
          </Show>
        </section>

        <button type="button" class="btn-primary btn-start" disabled>
          Start Game (soon)
        </button>
      </Show>
    </main>
  );
};
