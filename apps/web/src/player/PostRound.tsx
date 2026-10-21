import { createSignal, For, onCleanup, Show } from 'solid-js';
import type { Snapshot } from '@aux/shared';
import { JudgeBullets } from '../shared-ui/judge-bullets.js';

const TITLES = ['AUX GOD', 'CERTIFIED DJ', 'TASTE DEMON'];

/**
 * Player post-round mirror: your own verdict during RESULTS, the standings at
 * LEADERBOARD, and the personalised winner screen at GAME_OVER. Rematch exits
 * through `onRematch`: GAME_OVER is FSM-terminal, so play-again means a fresh
 * room via the join door.
 */
export function PlayerPostRound(props: {
  snapshot: Snapshot;
  nickname: string;
  onRematch?: () => void;
}) {
  const gameOver = () => props.snapshot.state === 'GAME_OVER';
  const board = () => props.snapshot.leaderboard ?? [];
  const hasWinner = () => (board()[0]?.totalScore ?? 0) > 0;
  const winners = () =>
    hasWinner() ? board().filter((row) => row.totalScore === board()[0]?.totalScore) : [];
  const iWon = () => gameOver() && winners().some((row) => row.nickname === props.nickname);
  const [titleIdx, setTitleIdx] = createSignal(0);
  const spin = setInterval(() => setTitleIdx((n) => (n + 1) % TITLES.length), 2400);
  onCleanup(() => clearInterval(spin));
  const myResult = () => props.snapshot.results?.find((result) => result.owner === props.nickname);

  return (
    <div class="p-screen p-postround">
      <header class="p-top">
        <span class="kicker">
          {gameOver()
            ? 'Game over'
            : props.snapshot.state === 'LEADERBOARD'
              ? 'Standings'
              : 'The reveal'}
        </span>
      </header>

      <Show when={props.snapshot.state === 'RESULTS'}>
        <Show
          when={myResult()}
          fallback={
            <div class="p-hold pop">
              <span class="thinking-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              <p class="p-hold-text">Reveal in progress. Watch the host screen.</p>
            </div>
          }
        >
          {(result) => (
            <article class="p-verdict pop" data-rank={result().rank}>
              <span class="stamp" classList={{ 'stamp--lime': result().rank === 1 }}>
                {result().judgeModel === 'crowd-no-votes' ? 'No winner' : `#${result().rank}`}
              </span>
              <h2 class="display">{result().track.title}</h2>
              <p class="p-verdict-artist">{result().track.artist}</p>
              <p class="p-verdict-score mono">
                <Show when={result().judgeModel !== 'crowd-no-votes'} fallback="No votes">
                  {result().score}
                  <small>{result().judgeModel === 'crowd-vote-v1' ? '% vote share' : '/100'}</small>
                </Show>
              </p>
              <JudgeBullets judgement={result()} />
              <Show when={result().chicken}>
                <p class="muted">Chicken pick. The judge chose this for you.</p>
              </Show>
            </article>
          )}
        </Show>
      </Show>

      <Show when={gameOver()}>
        <div class="p-finale pop">
          <Show
            when={iWon()}
            fallback={
              <>
                <h2 class="display">
                  {!hasWinner()
                    ? 'No winner this time'
                    : winners().length > 1
                      ? 'A tie for the aux'
                      : `${board()[0]?.nickname ?? 'Someone'} held the aux`}
                </h2>
              </>
            }
          >
            <span class="stamp stamp--lime">{TITLES[titleIdx()]}</span>
            <h2 class="display">{winners().length > 1 ? 'You share the win' : 'You won'}</h2>
          </Show>
        </div>
      </Show>

      <Show when={gameOver() || props.snapshot.state === 'LEADERBOARD'}>
        <ol class="p-board">
          <For each={board()}>
            {(entry, i) => (
              <li
                class="p-board-row rise"
                style={{ 'animation-delay': `${i() * 50}ms` }}
                classList={{ 'is-me': entry.nickname === props.nickname }}
              >
                <span class="p-board-rank mono">{i() + 1}</span>
                <span class="p-board-name">{entry.nickname}</span>
                <strong class="p-board-points mono">{entry.totalScore}</strong>
              </li>
            )}
          </For>
        </ol>
      </Show>

      <Show when={gameOver()}>
        <div class="p-cta-bar">
          <button
            type="button"
            class="btn btn--primary btn--big btn--block"
            onClick={() => props.onRematch?.()}
          >
            {iWon() ? 'Defend the title' : 'Run it back'}
          </button>
          <p class="p-fine">Grab the new code from the host.</p>
        </div>
      </Show>
    </div>
  );
}
