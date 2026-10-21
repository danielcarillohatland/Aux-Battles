import { createSignal, For, onCleanup, Show } from 'solid-js';
import type { Snapshot } from '@aux/shared';
import { JUDGING_CATEGORY_MAX } from '@aux/shared';
import { startConfettiLifecycle } from '../confetti.js';
import { JudgeBullets } from '../../shared-ui/judge-bullets.js';
import { VibeLine } from '../../shared-ui/vibe-line.js';

const RUBRIC: ReadonlyArray<{ key: keyof typeof JUDGING_CATEGORY_MAX; label: string }> = [
  { key: 'scenarioFit', label: 'Scene' },
  { key: 'mood', label: 'Mood' },
  { key: 'lyrics', label: 'Lyrics' },
  { key: 'genre', label: 'Genre' },
  { key: 'wildcard', label: 'Wildcard' },
];

/** Scores stay private until every song in this round has a valid judgement. */
export function JudgingView(props: { snapshot: Snapshot; busy: boolean; onNext: () => void }) {
  const result = () => props.snapshot.judgingResult;
  const count = () => props.snapshot.judgingCount ?? props.snapshot.queue?.length ?? 0;
  const index = () => props.snapshot.judgingIndex ?? 0;
  const completed = () => props.snapshot.judgingCompleted ?? 0;
  const revealed = () => props.snapshot.judgingStatus === 'revealed' && result() != null;
  return (
    <section class="screen judging" data-status={props.snapshot.judgingStatus}>
      <Show
        when={revealed()}
        fallback={
          <div class="judging-thinking" role="status">
            <h1 class="display">The judge is deciding.</h1>
            <div class="judging-progress">
              <progress max={Math.max(1, count())} value={completed()} aria-label="Songs judged" />
              <p>
                {completed()} of {count()} songs reviewed
              </p>
            </div>
            <p>One rubric. Every song. Then the verdict.</p>
          </div>
        }
      >
        <p class="judging-scene">{props.snapshot.scenario}</p>
        <VibeLine vibe={props.snapshot.scenarioVibe} />
        <Show when={props.snapshot.judgingTrack}>
          {(track) => (
            <article class="judging-song">
              <Show when={track().artUrl}>
                {(art) => <img src={art()} alt="" class="judging-art" />}
              </Show>
              <div class="judging-song-text">
                <h1 class="display">{track().title}</h1>
                <p class="muted">{track().artist}</p>
              </div>
            </article>
          )}
        </Show>
        <div class="verdict pop">
          <div class="verdict-score">
            <strong class="display mono">{result()!.totalScore.toFixed(1)}</strong>
            <span class="muted">/ 10</span>
          </div>
          <p class="verdict-summary">
            {result()!.verdict ?? result()!.reasons?.[0] ?? result()!.explanation}
          </p>
          <details class="judging-reasoning">
            <summary>Why this score?</summary>
            <Show when={props.snapshot.judgingDefense}>
              {(defense) => <p class="defense-quote">“{defense()}”</p>}
            </Show>
            <ul class="rubric" aria-label="Scoring rubric">
              <For each={RUBRIC}>
                {(item) => {
                  const value = () => result()!.categories[item.key];
                  const max = JUDGING_CATEGORY_MAX[item.key];
                  return (
                    <li>
                      <span class="rubric-label">{item.label}</span>
                      <span class="rubric-bar" aria-hidden="true">
                        <i style={{ width: `${(value() / max) * 100}%` }} />
                      </span>
                      <span class="rubric-value mono">
                        {value()}/{max}
                      </span>
                    </li>
                  );
                }}
              </For>
            </ul>
            <JudgeBullets judgement={result()!} />
            <p class="muted">
              Scores use song knowledge and the submitted context. The judge does not hear the
              audio.
            </p>
          </details>
        </div>
        <div class="stage-cta">
          <button
            type="button"
            class="btn btn--primary btn--big btn--block"
            disabled={props.busy}
            onClick={props.onNext}
          >
            {index() + 1 >= count() ? 'Show the ranking' : `Next song · ${index() + 1}/${count()}`}
          </button>
        </div>
      </Show>
    </section>
  );
}

/** LEADERBOARD: standings with point bars. */
export function LeaderboardView(props: {
  snapshot: Snapshot;
  busy: boolean;
  onNextRound: () => void;
  onFinish: () => void;
}) {
  const board = () => props.snapshot.leaderboard ?? [];
  const top = () => Math.max(1, ...board().map((entry) => entry.totalScore));
  return (
    <section class="screen standings">
      <p class="kicker">
        After round <b>{props.snapshot.roundIdx + 1}</b>
      </p>
      <h2 class="display">Standings</h2>
      <ol class="board">
        <For each={board()}>
          {(entry, i) => (
            <li class="board-row rise" style={{ 'animation-delay': `${i() * 60}ms` }}>
              <span class="board-rank mono">{i() + 1}</span>
              <span class="board-name">
                {entry.nickname}
                <small>
                  {entry.wins} win{entry.wins === 1 ? '' : 's'}
                </small>
              </span>
              <span class="board-bar" aria-hidden="true">
                <i style={{ width: `${(entry.totalScore / top()) * 100}%` }} />
              </span>
              <strong class="board-points mono">{entry.totalScore}</strong>
            </li>
          )}
        </For>
      </ol>
      <div class="stage-cta stage-cta--split">
        <button type="button" class="btn btn--ghost" disabled={props.busy} onClick={props.onFinish}>
          Finish game
        </button>
        <Show when={props.snapshot.roundIdx < 4}>
          <button
            type="button"
            class="btn btn--primary"
            disabled={props.busy}
            onClick={props.onNextRound}
          >
            Next round
          </button>
        </Show>
      </div>
    </section>
  );
}

const WINNER_TITLES = ['AUX GOD', 'CERTIFIED DJ', 'TASTE DEMON'];
const CONFETTI_COLORS = ['#304bc7', '#d95734', '#ead5e3', '#f1c7af'];

/**
 * GAME_OVER — the winner screen: champion name huge, rotating title, podium,
 * CSS-only confetti ×3, and Play Again. Play Again is a NEW ROOM by design:
 * GAME_OVER is FSM-terminal, so a fresh lobby is the only honest rematch path.
 */
export function GameOverView(props: {
  snapshot: Snapshot;
  busy: boolean;
  onPlayAgain: () => void;
}) {
  const board = () => props.snapshot.leaderboard ?? [];
  const hasWinner = () => (board()[0]?.totalScore ?? 0) > 0;
  const winners = () =>
    hasWinner() ? board().filter((entry) => entry.totalScore === board()[0]!.totalScore) : [];
  const champion = () => winners()[0];
  const place = (index: number) =>
    board().findIndex((entry) => entry.totalScore === board()[index]?.totalScore) + 1;
  const places = () => [1, 0, 2].filter((i) => i < board().length);
  const [titleIdx, setTitleIdx] = createSignal(0);
  const [showConfetti, setShowConfetti] = createSignal(true);
  const spin = setInterval(() => setTitleIdx((n) => (n + 1) % WINNER_TITLES.length), 2400);
  const stopConfetti = startConfettiLifecycle(() => setShowConfetti(false));
  onCleanup(() => {
    clearInterval(spin);
    stopConfetti();
  });

  return (
    <section class="screen finale">
      <Show when={showConfetti() && hasWinner()}>
        <div class="rv-confetti" aria-hidden="true">
          <For each={[0, 1, 2]}>
            {(burst) => (
              <div class="rv-burst">
                <For each={Array.from({ length: 12 }, (_, i) => i)}>
                  {(i) => (
                    <span
                      style={{
                        '--cx': `${(i - 5.5) * 11 + ((burst * 41) % 19)}vw`,
                        '--cd': `${((i * 67 + burst * 53) % 400) + burst * 700}ms`,
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
      </Show>
      <p class="kicker">Game over</p>
      <Show
        when={champion()}
        fallback={
          <>
            <h2 class="display">No winner this time.</h2>
            <p class="muted">No points were awarded.</p>
          </>
        }
      >
        {(c) => (
          <div class="champion pop">
            <span class="stamp stamp--lime">
              {winners().length > 1 ? 'Shared win' : WINNER_TITLES[titleIdx()]}
            </span>
            <h2 class="display champion-name">
              {winners()
                .map((entry) => entry.nickname)
                .join(' + ')}
            </h2>
            <p class="muted mono">
              {c().totalScore} points · {c().wins} round win{c().wins === 1 ? '' : 's'}
            </p>
          </div>
        )}
      </Show>
      <Show when={hasWinner()}>
        <div class="podium" aria-label="Podium">
          <For each={places()}>
            {(i) => (
              <div
                class="podium-col rise"
                data-place={place(i)}
                style={{ 'animation-delay': `${i * 90}ms` }}
              >
                <span class="podium-nick">{board()[i]?.nickname}</span>
                <strong class="podium-score mono">{board()[i]?.totalScore}</strong>
                <div class="podium-block">
                  <span class="display">{place(i)}</span>
                </div>
              </div>
            )}
          </For>
        </div>
      </Show>
      <div class="stage-cta">
        <button
          type="button"
          class="btn btn--primary btn--big btn--block"
          disabled={props.busy}
          onClick={props.onPlayAgain}
        >
          Play again
        </button>
        <p class="muted">Fresh room, new code, same crowd.</p>
      </div>
    </section>
  );
}
