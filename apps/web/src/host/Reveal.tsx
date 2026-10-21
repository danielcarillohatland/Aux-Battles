/**
 * AUX BATTLES — the Reveal (TDD §9: "the reveal is the product").
 * Worst→best choreography on the host screen, mirrored to players through the
 * server: every beat asks the server to reveal one more result; the snapshot
 * brings it back and the card slams in. The winner stays on screen with its
 * bullets until the host presses Continue, which closes the round.
 *
 * Beats play themselves (entrance + ≤600 ms gap). Tap / Space = next beat;
 * hold ≥600 ms = jump to the winner. Reduced motion shows a plain ranked list.
 */
import { createEffect, createMemo, createSignal, For, Show, onCleanup } from 'solid-js';
import { startConfettiLifecycle } from './confetti.js';
import { JudgeBullets } from '../shared-ui/judge-bullets.js';

export interface RevealEntry {
  rank: number;
  score: number;
  title: string;
  artist: string;
  explanation: string;
  judgeModel?: string;
  nickname: string;
  chicken?: boolean;
  reasons?: string[];
  defenseNote?: string;
  verdict?: string;
  defense?: string;
}

export interface RevealProps {
  /** Entries revealed so far (server mirror from the room snapshot). */
  results: readonly RevealEntry[];
  /** Announced result count for this round (snapshot.resultCount), when known. */
  totalCount?: number | undefined;
  busy: boolean;
  onAdvance: (final: boolean) => void;
}

const LONG_PRESS_MS = 600;
const BEAT_GAP_MS = 600;
const REVEAL_CONFETTI_MS = 2_400;

/** Entrance duration per ordinal: mid ranks accelerate, the winner lands slow and heavy. */
const entranceMs = (ordinal: number, total: number): number =>
  ordinal >= total ? 520 : Math.max(240, 520 - ordinal * 45);

// ── Tiny WebAudio synth (no assets, gesture-gated by the host's taps) ────────

function createSfx(enabled: () => boolean) {
  let ctx: AudioContext | null = null;
  const ensure = (): AudioContext | null => {
    if (!enabled()) return null;
    try {
      ctx ??= new AudioContext();
      if (ctx.state === 'suspended') void ctx.resume();
      return ctx;
    } catch {
      return null;
    }
  };
  const tone = (
    at: number,
    freq: number,
    dur: number,
    type: OscillatorType,
    peak: number,
    slideTo?: number,
  ) => {
    const ac = ensure();
    if (!ac) return;
    const t0 = ac.currentTime + at;
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo !== undefined) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(peak, t0 + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain).connect(ac.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  };
  return {
    tick(step: number) {
      tone(0, 220 * 2 ** (step / 6), 0.09, 'square', 0.05);
    },
    slam() {
      tone(0, 160, 0.4, 'sawtooth', 0.14, 55);
    },
    riser() {
      tone(0, 180, 0.5, 'sawtooth', 0.06, 720);
    },
    fanfare() {
      [392, 494, 587, 784].forEach((f, i) => tone(i * 0.09, f, 0.35, 'triangle', 0.09));
    },
  };
}

export const Reveal = (props: RevealProps) => {
  const [beat, setBeat] = createSignal(0); // 0 = drumroll · 1..total = revealed ordinals
  const [flash, setFlash] = createSignal(false);
  const [showConfetti, setShowConfetti] = createSignal(false);
  const motionQuery =
    typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null;
  const [reduced, setReduced] = createSignal(motionQuery?.matches ?? false);
  const onMotionChange = () => setReduced(motionQuery?.matches ?? false);
  motionQuery?.addEventListener?.('change', onMotionChange);
  onCleanup(() => motionQuery?.removeEventListener?.('change', onMotionChange));

  let root: HTMLElement | undefined;
  const timers: ReturnType<typeof setTimeout>[] = [];
  const later = (fn: () => void, ms: number) => timers.push(setTimeout(fn, ms));
  onCleanup(() => timers.forEach(clearTimeout));

  const sfx = createSfx(() => !reduced());

  const ordered = createMemo<readonly RevealEntry[]>(() =>
    [...props.results].sort((a, b) => b.rank - a.rank),
  );
  const total = () => Math.max(props.totalCount ?? 0, ordered().length);
  const finished = () => total() > 0 && beat() >= total();
  const current = () => ordered()[beat() - 1];
  const canShow = (n: number) => n <= ordered().length;
  const freezeZone = () => !finished() && beat() >= total() - 2 && beat() > 0;
  const ghosts = () => Math.max(0, total() - beat());
  const winnerRevealed = () => finished() && canShow(total());

  let stopRevealConfetti: (() => void) | undefined;
  createEffect(() => {
    stopRevealConfetti?.();
    stopRevealConfetti = undefined;
    if (!winnerRevealed() || reduced() || current()?.judgeModel === 'crowd-no-votes') {
      setShowConfetti(false);
      return;
    }
    setShowConfetti(true);
    stopRevealConfetti = startConfettiLifecycle(() => setShowConfetti(false), REVEAL_CONFETTI_MS);
  });
  onCleanup(() => stopRevealConfetti?.());

  const tier = (ordinal: number) =>
    ordinal >= total() ? 'winner' : ordinal <= 1 ? 'slam' : ordinal > total() - 2 ? 'top' : 'mid';

  const flashFx = () => {
    if (reduced()) return;
    setFlash(true);
    later(() => setFlash(false), 420);
  };
  const shakeFx = () => {
    if (!root || reduced()) return;
    root.classList.remove('do-shake');
    void root.offsetWidth;
    root.classList.add('do-shake');
    later(() => root?.classList.remove('do-shake'), 500);
  };

  // ── Beat engine ─────────────────────────────────────────────────────────────

  let autoTimer: ReturnType<typeof setTimeout> | undefined;
  const clearAuto = () => {
    clearTimeout(autoTimer);
    autoTimer = undefined;
  };
  onCleanup(clearAuto);

  const enterBeat = (ordinal: number) => {
    setBeat(ordinal);
    if (ordered().some((entry) => entry.judgeModel === 'crowd-no-votes')) return;
    if (ordinal < total()) {
      if (ordinal === 1) {
        sfx.slam();
        shakeFx();
      } else {
        sfx.tick(ordinal);
        if (ordinal === total() - 1) sfx.riser();
      }
    } else {
      flashFx();
      sfx.fanfare();
    }
  };

  const scheduleNext = (ms?: number) => {
    clearAuto();
    if (reduced() || total() === 0 || finished()) return;
    const next = beat() + 1;
    const delay = ms ?? entranceMs(next, total()) + BEAT_GAP_MS;
    autoTimer = setTimeout(() => {
      autoTimer = undefined;
      // A host request in flight or a lagging mirror: poll briefly, never drop a beat.
      if (props.busy || !canShow(beat())) {
        scheduleNext(260);
        return;
      }
      fire(beat() + 1);
    }, delay);
  };

  /** Play ordinal n and ask the server to reveal it (players sync). */
  const fire = (n: number) => {
    enterBeat(n);
    props.onAdvance(false);
    if (n < total()) scheduleNext();
  };

  const advance = () => {
    if (props.busy || total() === 0 || finished()) return;
    clearAuto();
    fire(beat() + 1);
  };

  /** Continue closes the round on the server → LEADERBOARD. */
  const continueToLeaderboard = () => {
    if (props.busy) return;
    props.onAdvance(true);
  };

  /** Reveal everything at once (reduced motion / long press). */
  const revealAll = () => {
    clearAuto();
    const remaining = total() - beat();
    setBeat(total());
    for (let i = 0; i < remaining; i += 1) props.onAdvance(false);
  };

  // ── Input: tap / space / long-press skip ───────────────────────────────────

  let pressTimer: ReturnType<typeof setTimeout> | undefined;
  let longFired = false;
  const skipToWinner = () => {
    if (props.busy || total() === 0 || finished()) return;
    longFired = true;
    revealAll();
    flashFx();
  };
  const onPointerDown = () => {
    longFired = false;
    clearTimeout(pressTimer);
    pressTimer = setTimeout(skipToWinner, LONG_PRESS_MS);
  };
  const cancelPress = () => clearTimeout(pressTimer);
  const onTap = () => {
    if (!longFired) advance();
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key !== ' ' && ev.key !== 'Enter') return;
    const target = ev.target as HTMLElement | null;
    if (target?.tagName === 'BUTTON') return;
    ev.preventDefault();
    advance();
  };
  window.addEventListener('keydown', onKey);
  onCleanup(() => window.removeEventListener('keydown', onKey));

  // ── Render ──────────────────────────────────────────────────────────────────

  const bestFirst = () => [...ordered()].sort((a, b) => a.rank - b.rank);
  const beatDurVar = (ordinal: number) => ({ '--beat-dur': `${entranceMs(ordinal, total())}ms` });
  const stop = (fn: () => void) => (e: Event) => {
    e.stopPropagation();
    fn();
  };

  return (
    <section
      ref={root}
      class="rv"
      classList={{ 'rv-freeze': freezeZone(), 'rv-podium': finished(), 'rv-reduced': reduced() }}
      data-beat={beat()}
      onPointerDown={onPointerDown}
      onPointerUp={cancelPress}
      onPointerLeave={cancelPress}
      onPointerCancel={cancelPress}
      onClick={onTap}
    >
      <Show when={flash()}>
        <div class="rv-flash" aria-hidden="true" />
      </Show>
      <Show when={showConfetti()}>
        <div class="rv-confetti" aria-hidden="true">
          <For each={[0, 1, 2]}>
            {(burst) => (
              <div class="rv-burst">
                <For each={Array.from({ length: 14 }, (_, i) => i)}>
                  {(i) => (
                    <span
                      style={{
                        '--cx': `${(i - 6.5) * 9 + ((burst * 37) % 23)}vw`,
                        '--cd': `${((i * 53 + burst * 97) % 400) + burst * 500}ms`,
                        '--cr': `${(i * 137 + burst * 61) % 360}deg`,
                        '--cc': ['#304bc7', '#d95734', '#ead5e3', '#f1c7af'][i % 4],
                      }}
                    />
                  )}
                </For>
              </div>
            )}
          </For>
        </div>
      </Show>

      <p class="kicker rv-progress">
        The reveal · {Math.min(beat(), total())}/{total()}
        <Show when={!reduced() && !finished()}> · tap for next, hold to skip</Show>
      </p>

      <Show
        when={!reduced()}
        fallback={
          <div class="rv-list">
            <Show when={ordered().length < total()}>
              <button
                type="button"
                class="btn btn--primary btn--block"
                disabled={props.busy || total() === 0}
                onClick={stop(revealAll)}
              >
                Show all results
              </button>
            </Show>
            <For each={bestFirst()}>
              {(entry) => (
                <article class="rv-row" data-rank={entry.rank}>
                  <span class="rv-row-rank">{entry.rank}</span>
                  <div class="rv-row-body">
                    <p class="rv-row-what">
                      <b>{entry.title}</b> · {entry.artist}
                    </p>
                    <p class="rv-row-who">
                      {entry.chicken ? 'Chicken · ' : ''}
                      {entry.nickname}
                    </p>
                    <JudgeBullets judgement={entry} />
                  </div>
                  <strong class="rv-row-score mono">
                    <Show when={entry.judgeModel !== 'crowd-no-votes'} fallback="No votes">
                      {entry.score}
                      <small>
                        {entry.judgeModel === 'crowd-vote-v1' ? '% vote share' : '/100'}
                      </small>
                    </Show>
                  </strong>
                </article>
              )}
            </For>
            <Show when={ordered().length >= total() && total() > 0}>
              <button
                type="button"
                class="btn btn--primary btn--block"
                disabled={props.busy}
                onClick={stop(continueToLeaderboard)}
              >
                {props.busy ? 'Closing…' : 'Continue'}
              </button>
            </Show>
          </div>
        }
      >
        <Show
          when={beat() > 0}
          fallback={
            <div class="rv-drumroll" role="status">
              <div class="rv-drum" aria-hidden="true">
                <i />
                <i />
                <i />
              </div>
              <h2 class="display rv-drum-title">Who nailed it?</h2>
              <button
                type="button"
                class="btn btn--primary btn--big"
                disabled={props.busy || total() === 0}
                onClick={stop(advance)}
              >
                Start the reveal
              </button>
            </div>
          }
        >
          <Show when={current()} fallback={<div class="rv-card rv-pending">…</div>}>
            {(entry) => (
              <>
                <Show when={freezeZone()}>
                  <div class="rv-ghosts" aria-hidden="true">
                    <For each={Array.from({ length: ghosts() }, (_, i) => i)}>
                      {() => <div class="rv-ghost">?</div>}
                    </For>
                  </div>
                </Show>

                <article
                  class="rv-card"
                  data-tier={entry().judgeModel === 'crowd-no-votes' ? 'mid' : tier(beat())}
                  data-rank={entry().rank}
                  style={beatDurVar(beat())}
                >
                  <span class="stamp rv-rank" classList={{ 'stamp--lime': beat() === total() }}>
                    {entry().judgeModel === 'crowd-no-votes'
                      ? 'No winner'
                      : entry().rank === 1
                        ? ordered().filter((row) => row.rank === 1).length > 1
                          ? 'Joint winner'
                          : 'Winner'
                        : `#${entry().rank}`}
                  </span>
                  <h3 class="display rv-title">{entry().title}</h3>
                  <p class="rv-artist">{entry().artist}</p>
                  <p class="rv-owner">
                    <span class="kicker">played by</span>
                    <strong>
                      {entry().chicken ? 'Chicken · ' : ''}
                      {entry().nickname}
                    </strong>
                  </p>
                  <strong class="rv-score mono">
                    <Show when={entry().judgeModel !== 'crowd-no-votes'} fallback="No votes">
                      {entry().score}
                      <small>
                        {entry().judgeModel === 'crowd-vote-v1' ? '% vote share' : '/100'}
                      </small>
                    </Show>
                  </strong>
                  <Show when={entry().defense}>
                    {(defense) => (
                      <p class="rv-defense">
                        <span class="kicker">their defense</span>“{defense()}”
                      </p>
                    )}
                  </Show>
                  <JudgeBullets judgement={entry()} />
                </article>

                <Show when={winnerRevealed()}>
                  <button
                    type="button"
                    class="btn btn--primary btn--big"
                    disabled={props.busy}
                    onClick={stop(continueToLeaderboard)}
                  >
                    {props.busy ? 'Closing…' : 'Continue'}
                  </button>
                </Show>
              </>
            )}
          </Show>
        </Show>
      </Show>
    </section>
  );
};
