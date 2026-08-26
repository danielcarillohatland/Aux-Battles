import { createSignal, For, onCleanup, Show } from 'solid-js';
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

/**
 * GAME_OVER — the winner screen (frontend-spec §2.11): podium of the top 3
 * (server-sorted snapshot leaderboard), champion card cycling rotating
 * adjectives, CSS-only confetti ×3, and the Play-Again CTA.
 *
 * Play Again is a NEW ROOM by design: the FSM declares GAME_OVER terminal
 * (`GAME_OVER: {}` in fsm/table.ts) so `next_round` would 409 — a fresh
 * /host.html lobby is the only honest rematch path.
 */
const WINNER_ADJECTIVES = ['AUX GOD', 'CERTIFIED DJ', 'TASTE DEMON'];
const CONFETTI_COLORS = ['#ff2fb4', '#7c3aed', '#ffda57', '#41e6c0', '#ff7a45'];

export function GameOverView(props: { snapshot: Snapshot }) {
  const board = () => props.snapshot.leaderboard ?? [];
  const champion = () => board()[0];
  // Visual order 2nd · 1st · 3rd; short boards just shrink the podium.
  const places = () => [1, 0, 2].filter((i) => i < board().length);
  const placeMedal = (i: number) => ['🥇', '🥈', '🥉'][i] ?? '';

  const [adjectiveIdx, setAdjectiveIdx] = createSignal(0);
  const spin = setInterval(() => setAdjectiveIdx((n) => (n + 1) % WINNER_ADJECTIVES.length), 2400);
  onCleanup(() => clearInterval(spin));

  return (
    <div class="round-card winner-stage">
      <Show when={!champion()}>
        <p class="scenario-big">the aux has spoken</p>
      </Show>
      <Show when={champion()}>
        {(c) => (
          <>
            {/* Three confetti waves ~700 ms apart — §2.11 "confetti cannon ×3". */}
            <div class="winner-confetti" aria-hidden="true">
              <For each={[0, 1, 2]}>
                {(burst) => (
                  <div class="winner-burst">
                    <For each={Array.from({ length: 12 }, (_, i) => i)}>
                      {(i) => (
                        <span
                          style={{
                            '--cx': `${(i - 5.5) * 11 + ((burst * 41) % 19)}vw`,
                            '--cd': `${(i * 67 + burst * 53) % 400}ms`,
                            '--cw': `${burst * 700}ms`,
                            '--cr': `${(i * 137 + burst * 61) % 360}deg`,
                            '--cc': CONFETTI_COLORS[(i + burst) % CONFETTI_COLORS.length],
                          }}
                        />
                      )}
                    </For>
                  </div>
                )}
              </For>
            </div>
            <p class="winner-crown">👑</p>
            <h2 class="round-heading">game over</h2>
            <p class="winner-champ">{c().nickname}</p>
            <p class="winner-adjective" role="status">
              {WINNER_ADJECTIVES[adjectiveIdx()]}
            </p>
            <p class="hint">
              {c().totalScore} points · {c().wins} round win{c().wins === 1 ? '' : 's'}
            </p>
          </>
        )}
      </Show>

      <div class="podium">
        <For each={places()}>
          {(i) => (
            <div class="podium-col" data-place={i + 1}>
              <span class="podium-nick">{board()[i]?.nickname}</span>
              <strong class="podium-score">{board()[i]?.totalScore}</strong>
              <div class="podium-block">
                <span>{placeMedal(i)}</span>
              </div>
            </div>
          )}
        </For>
      </div>

      <a class="btn-primary btn-start" href="/host.html">
        Play again 🔁
      </a>
      <p class="hint">fresh room — grab the new QR and run it back</p>
    </div>
  );
}
