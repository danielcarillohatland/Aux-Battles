import { For, Show } from 'solid-js';
import type { Snapshot } from '@aux/shared';

export function PlayerPostRound(props: { snapshot: Snapshot; nickname: string }) {
  const myResult = () => props.snapshot.results?.find((result) => result.owner === props.nickname);
  const winner = () => props.snapshot.leaderboard?.[0];
  return (
    <div class="p-screen p-results-screen">
      <header class="p-head">
        <h1>{props.snapshot.state === 'GAME_OVER' ? 'GAME OVER' : 'THE VERDICT'}</h1>
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
        <Show when={props.snapshot.state !== 'RESULTS'}>
          <h2>
            {props.snapshot.state === 'GAME_OVER'
              ? `${winner()?.nickname ?? 'Someone'} wins 👑`
              : 'standings'}
          </h2>
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
