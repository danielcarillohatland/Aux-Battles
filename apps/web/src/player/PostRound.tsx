import { createSignal, For, onCleanup, Show } from 'solid-js';
import type { Snapshot } from '@aux/shared';

/**
 * Player post-round mirror. At GAME_OVER this becomes the personalized winner
 * screen (frontend-spec §2.11): champion gets the gold "YOU WON" treatment,
 * everyone else gets the "REVENGE?" tease — plus a compact top-3 podium for
 * all. Rematch exits through `onRematch`: GAME_OVER is FSM-terminal, so the
 * only play-again path is a fresh room via the join door.
 */
const PODIUM_MEDALS = ['🥇', '🥈', '🥉'];

export function PlayerPostRound(props: {
  snapshot: Snapshot;
  nickname: string;
  onRematch?: () => void;
}) {
  const gameOver = () => props.snapshot.state === 'GAME_OVER';
  const board = () => props.snapshot.leaderboard ?? [];
  const podium = () => board().slice(0, 3);
  const rest = () => board().slice(3);
  const iWon = () => gameOver() && board()[0]?.nickname === props.nickname;

  // Rotating champion adjective — mirrors the host winner screen.
  const ADJECTIVES = ['AUX GOD', 'CERTIFIED DJ', 'TASTE DEMON'];
  const [adjectiveIdx, setAdjectiveIdx] = createSignal(0);
  const spin = setInterval(() => setAdjectiveIdx((n) => (n + 1) % ADJECTIVES.length), 2400);
  onCleanup(() => clearInterval(spin));

  const myResult = () => props.snapshot.results?.find((result) => result.owner === props.nickname);

  return (
    <div class="p-screen p-results-screen">
      <header class="p-head">
        <h1>{gameOver() ? 'GAME OVER' : 'THE VERDICT'}</h1>
      </header>
      <div class="p-card">
        <Show when={myResult()}>
          {(result) => (
            <div class="p-personal-result">
              <p class="p-chicken-stamp">#{result().rank}</p>
              <h2>{result().track.title}</h2>
              <p>
                {result().score}/100 · {result().explanation}
              </p>
              <Show when={result().chicken}>
                <p>CHICKEN 🐔</p>
              </Show>
            </div>
          )}
        </Show>

        {/* ── Winner screen (§2.11): personal verdict + compact podium ── */}
        <Show when={gameOver()}>
          <Show
            when={iWon()}
            fallback={
              <p class="p-respect">
                🫡 respect. <strong>{board()[0]?.nickname ?? 'someone'}</strong> held the aux
                tonight.
              </p>
            }
          >
            <div class="p-winner-me">
              <p class="p-you-won">🏆 YOU WON</p>
              <p class="p-winner-sub">{ADJECTIVES[adjectiveIdx()]}</p>
            </div>
          </Show>

          <ol class="p-podium">
            <For each={podium()}>
              {(entry, i) => (
                <li data-place={i() + 1} classList={{ me: entry.nickname === props.nickname }}>
                  <span>
                    {PODIUM_MEDALS[i()] ?? `#${i() + 1}`} {entry.nickname}
                  </span>
                  <strong>{entry.totalScore}</strong>
                </li>
              )}
            </For>
          </ol>
          <Show when={rest().length > 0}>
            <ol class="p-leaderboard p-rest">
              <For each={rest()}>
                {(entry, i) => (
                  <li classList={{ me: entry.nickname === props.nickname }}>
                    <span>
                      #{i() + 4} {entry.nickname}
                    </span>
                    <strong>{entry.totalScore}</strong>
                  </li>
                )}
              </For>
            </ol>
          </Show>

          <button type="button" class="p-cta p-again" onClick={() => props.onRematch?.()}>
            {iWon() ? 'DEFEND THE TITLE 🔁' : 'REVENGE? ⚔'}
          </button>
          <p class="p-hint">opens a fresh room — grab the new code from the host</p>
        </Show>

        <Show when={props.snapshot.state === 'LEADERBOARD'}>
          <h2>standings</h2>
          <ol class="p-leaderboard">
            <For each={props.snapshot.leaderboard ?? []}>
              {(entry) => (
                <li classList={{ me: entry.nickname === props.nickname }}>
                  <span>{entry.nickname}</span>
                  <strong>{entry.totalScore}</strong>
                </li>
              )}
            </For>
          </ol>
        </Show>

        <Show when={props.snapshot.state === 'RESULTS' && !myResult()}>
          <p class="p-sub">reveal in progress… hold your nerve</p>
        </Show>
      </div>
    </div>
  );
}
