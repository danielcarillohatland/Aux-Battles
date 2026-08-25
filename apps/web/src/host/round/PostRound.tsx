import { For, Show } from 'solid-js';
import type { Snapshot } from '@aux/shared';

export function JudgingView() {
  return (
    <div class="round-card" role="status">
      <h2 class="round-heading">the judge is thinking… 🤖</h2>
      <p class="hint">comparing every song in one ruthless verdict</p>
    </div>
  );
}

export function ResultsReveal(props: {
  snapshot: Snapshot;
  busy: boolean;
  onAdvance: (final: boolean) => void;
}) {
  const revealed = () => props.snapshot.results ?? [];
  const latest = () => revealed().at(-1);
  const total = () => props.snapshot.resultCount ?? revealed().length;
  const nextIsFinal = () => revealed().length + 1 >= total();
  return (
    <div class="round-card reveal-stage">
      <h2 class="round-heading">the verdict</h2>
      <Show when={latest()} fallback={<p class="scenario-big">ready to reveal last place?</p>}>
        {(result) => (
          <article class="result-card" data-rank={result().rank}>
            <p class="p-round-tag">#{result().rank}</p>
            <h3>{result().track.title}</h3>
            <p>{result().track.artist}</p>
            <strong>{result().score}/100</strong>
            <p>{result().explanation}</p>
            <p class="result-owner">
              {result().chicken ? '🐔 ' : ''}
              {result().owner}
            </p>
          </article>
        )}
      </Show>
      <p class="hint">
        {revealed().length}/{total()} revealed
      </p>
      <button
        type="button"
        class="btn-primary btn-start"
        disabled={props.busy || total() === 0}
        onClick={() => props.onAdvance(nextIsFinal())}
      >
        {props.busy ? 'Revealing…' : nextIsFinal() ? 'Reveal winner 🏆' : 'Reveal next ▶'}
      </button>
    </div>
  );
}

export function LeaderboardView(props: {
  snapshot: Snapshot;
  busy: boolean;
  onNextRound: () => void;
  onFinish: () => void;
}) {
  return (
    <div class="round-card leaderboard-board">
      <h2 class="round-heading">standings</h2>
      <ol>
        <For each={props.snapshot.leaderboard ?? []}>
          {(entry) => (
            <li>
              <span>{entry.nickname}</span>
              <strong>{entry.totalScore}</strong>
              <small>
                {entry.wins} win{entry.wins === 1 ? '' : 's'}
              </small>
            </li>
          )}
        </For>
      </ol>
      <div class="host-actions">
        <button class="btn-primary" disabled={props.busy} onClick={props.onNextRound}>
          Next round ▶
        </button>
        <button class="btn-retry" disabled={props.busy} onClick={props.onFinish}>
          Finish game
        </button>
      </div>
    </div>
  );
}

export function GameOverView(props: { snapshot: Snapshot }) {
  const winner = () => props.snapshot.leaderboard?.[0];
  return (
    <div class="round-card winner-stage">
      <p class="winner-crown">👑</p>
      <h2 class="round-heading">{winner()?.nickname ?? 'AUX legend'} wins!</h2>
      <p class="scenario-big">{winner()?.totalScore ?? 0} points</p>
      <a class="btn-primary" href="/host.html">
        New room
      </a>
    </div>
  );
}
