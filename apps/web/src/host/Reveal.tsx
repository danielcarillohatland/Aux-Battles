/**
 * AUX BATTLES — the Reveal (frontend-spec §5 / TDD §9: "the reveal is the product").
 * Self-playing worst→best choreography on the host screen:
 *
 *   drumroll → LAST PLACE slam (screen shake) → accelerating mid-ranks →
 *   TOP-2 freeze (blurred ghost cards + heartbeat) → riser →
 *   winner white-flash + crown drop + CSS-only confetti ×3.
 *
 * Beat engine: every beat runs entrance animation + a fixed 600 ms gap, so a
 * beat lands ≈1.1–1.2 s and the dead air between beats never exceeds 600 ms.
 * Mid-rank entrances shrink per ordinal, so the cadence accelerates toward the
 * top. Tap anywhere / Space advances to the next beat immediately; holding
 * ≥600 ms skips straight to the winner. `prefers-reduced-motion` swaps all
 * theatrics for an instant ranked list (and stops the auto-advance clock).
 *
 * Data sources, in priority order:
 *   1. `payload` prop — full ranking handed straight from the controller.
 *   2. Module-level signal — the controller validates a WS `judgement` frame
 *      with `publishJudgement(frame)` (@aux/shared JudgementPayloadSchema);
 *      no prop threading needed until the live wiring lands next phase.
 *   3. `results` prop — server-revealed mirror from room snapshots (works on
 *      the polling fallback too; degraded mode = no pre-final podium).
 *
 * With 1 or 2 available the winner podium renders locally before the final
 * server advance; with only 3 each beat mirrors one server-side reveal and the
 * last tap finalizes. All text renders as inert text; explanations are plain
 * text below their card facts (no HTML sink, TDD §8).
 */
import { createMemo, createSignal, For, Show, onCleanup } from 'solid-js';
import { JudgementPayloadSchema, type JudgementResult } from '@aux/shared';
import './reveal.css';

export interface RevealEntry {
  rank: number;
  score: number;
  title: string;
  artist: string;
  explanation: string;
  nickname: string;
  chicken?: boolean;
}

export interface RevealProps {
  /** Entries known so far (server-revealed mirror from the room snapshot). */
  results: readonly RevealEntry[];
  /** Announced result count for this round (snapshot.resultCount), when known. */
  totalCount?: number | undefined;
  busy: boolean;
  /** Full ranking off the WS `judgement` frame — enables the pre-final podium. */
  payload?: readonly JudgementResult[] | undefined;
  onAdvance: (final: boolean) => void;
}

/** Long-press duration for skip-to-winner. */
const LONG_PRESS_MS = 600;

/**
 * Max dead-air between beats (owner condition #10): the next beat fires as
 * soon as the current entrance finishes plus this much, so pacing stays tight
 * while the entrance itself carries the drama.
 */
const BEAT_GAP_MS = 600;

/** Entrance duration per ordinal (mirrored into CSS via --beat-dur): mid ranks accelerate. */
const entranceMs = (ordinal: number, total: number): number =>
  ordinal >= total ? 380 : Math.max(240, 520 - ordinal * 45);

// ── Module-level judgement signal (WS `judgement` frames land here) ──────────

const [published, setPublished] = createSignal<readonly JudgementResult[]>([]);

/**
 * Feed a raw WS `judgement` frame payload ({results:[…]}) through the shared
 * schema; valid rankings are published to every mounted Reveal instantly,
 * invalid frames are dropped. Returns whether the frame was accepted.
 */
export const publishJudgement = (raw: unknown): boolean => {
  const parsed = JudgementPayloadSchema.safeParse(raw);
  if (!parsed.success) return false;
  setPublished(parsed.data.results);
  return true;
};

/** Drop the published ranking (e.g. when the round rolls over). */
export const clearJudgement = (): void => {
  setPublished([]);
};

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
    /** Drumroll tick; pitch climbs +2 semitones per rank (spec §5). */
    tick(step: number) {
      const freq = 220 * 2 ** (step / 6); // ~+2 semitones per rank
      tone(0, freq, 0.09, 'square', 0.05);
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

// ── Component ─────────────────────────────────────────────────────────────────

export const Reveal = (props: RevealProps) => {
  const [beat, setBeat] = createSignal(0); // 0 = drumroll · 1..total = revealed ordinals
  const [flash, setFlash] = createSignal(false);
  const [reduced, setReduced] = createSignal(
    typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  let root: HTMLElement | undefined;
  const timers: ReturnType<typeof setTimeout>[] = [];
  const later = (fn: () => void, ms: number) => timers.push(setTimeout(fn, ms));
  onCleanup(() => timers.forEach(clearTimeout));
  onCleanup(() => window.removeEventListener('keydown', onKey));

  const motionQuery =
    typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null;
  const onMotionChange = () => setReduced(motionQuery?.matches ?? false);
  motionQuery?.addEventListener?.('change', onMotionChange);
  onCleanup(() => motionQuery?.removeEventListener?.('change', onMotionChange));

  const sfx = createSfx(() => !reduced());

  // Worst→best order; prop payload > module signal > snapshot mirror.
  const ordered = createMemo<readonly RevealEntry[]>(() => {
    const src = props.payload ?? (published().length > 0 ? published() : props.results);
    return [...src].sort((a, b) => b.rank - a.rank);
  });
  const total = () => Math.max(props.totalCount ?? 0, ordered().length);
  /** True when we hold the full ranking locally and can podium before the final advance. */
  const hasFullSource = () => props.payload !== undefined || published().length > 0;
  const hasFull = () => hasFullSource() && total() > 0 && ordered().length >= total();

  const finished = () => total() > 0 && beat() >= total();
  const current = () => ordered()[beat() - 1];
  /** Can ordinal n be shown yet? (snapshot mirror may lag the cadence briefly) */
  const canShow = (n: number) => n <= ordered().length;
  /** Freeze zone: everything from "two names left" up to (not incl.) the podium. */
  const freezeZone = () => !finished() && beat() >= total() - 2 && beat() > 0;
  const ghosts = () => Math.max(0, total() - beat());

  const ordinalClass = (ordinal: number) =>
    finished() || ordinal >= total()
      ? 'rv-tier-winner'
      : ordinal <= 1
        ? 'rv-tier-slam'
        : ordinal > total() - 2
          ? 'rv-tier-top'
          : 'rv-tier-mid';

  const flashFx = () => {
    if (reduced()) return;
    setFlash(true);
    later(() => setFlash(false), 420);
  };
  const shakeFx = () => {
    if (!root || reduced()) return;
    root.classList.remove('do-shake');
    void root.offsetWidth; // restart the CSS animation
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

  /** Enter the given ordinal with its drama + SFX (no scheduling side effects). */
  const enterBeat = (ordinal: number) => {
    setBeat(ordinal);
    if (ordinal < total()) {
      if (ordinal === 1) {
        sfx.slam();
        shakeFx(); // last place hits the stage
      } else {
        sfx.tick(ordinal);
        if (ordinal === total() - 1) sfx.riser(); // top-2 incoming
      }
    } else {
      flashFx(); // winner white-flash
      sfx.fanfare();
    }
  };

  /** Queue the next beat: entrance duration + BEAT_GAP_MS of dead air, max. */
  const scheduleNext = (ms?: number) => {
    clearAuto();
    if (reduced() || total() === 0 || finished()) return;
    const next = beat() + 1;
    const delay = ms ?? entranceMs(next, total()) + BEAT_GAP_MS;
    autoTimer = setTimeout(() => {
      autoTimer = undefined;
      // Host request in flight or server mirror lagging: poll briefly instead
      // of dropping a beat (network waits aren't theatrical delays).
      if (props.busy || !canShow(beat() + 1)) {
        scheduleNext(260);
        return;
      }
      fire(beat() + 1);
    }, delay);
  };

  /** Play ordinal n, sync the server reveal, then keep the cadence going. */
  const fire = (n: number) => {
    enterBeat(n);
    if (n < total()) {
      props.onAdvance(false); // reveal the next result server-side (players sync)
      scheduleNext();
    } else if (!hasFull()) {
      // Degraded (snapshot-only): finalize now; the server's final advance
      // carries everyone to LEADERBOARD. With full data the podium shows from
      // the payload and "Continue" sends the final instead.
      props.onAdvance(true);
    }
  };

  /** Tap/Space: advance immediately, cancelling any queued beat.
   *  Allowed under reduced motion too (no timers there; beats are silent no-ops
   *  that just move the invisible cursor so Continue/finalize stays reachable). */
  const advance = () => {
    if (props.busy || total() === 0 || finished()) return;
    clearAuto();
    fire(beat() + 1);
  };

  const continueToLeaderboard = () => {
    if (props.busy) return;
    props.onAdvance(true); // server closes out remaining reveals → LEADERBOARD
  };

  // ── Input: tap / space / long-press skip ───────────────────────────────────

  let pressTimer: ReturnType<typeof setTimeout> | undefined;
  let longFired = false;

  const skipToWinner = () => {
    if (props.busy || total() === 0 || finished()) return;
    clearAuto();
    longFired = true;
    setBeat(total());
    flashFx();
    if (!hasFull()) props.onAdvance(true); // trust the final advance to close out the round
    // hasFull(): podium renders from the payload; Continue finalizes server-side.
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
    if (target?.tagName === 'BUTTON') return; // let focused buttons handle themselves
    ev.preventDefault();
    advance();
  };
  window.addEventListener('keydown', onKey);

  // ── Render ──────────────────────────────────────────────────────────────────

  const bestFirst = () => [...ordered()].sort((a, b) => a.rank - b.rank);
  const progress = () => `${Math.min(beat(), total())}/${total()}`;
  const beatDurVar = (ordinal: number) => ({
    '--beat-dur': `${entranceMs(ordinal, total())}ms`,
  });

  return (
    <section
      ref={root}
      class="rv"
      classList={{
        'rv-freeze': freezeZone(),
        'rv-podium': finished(),
        'rv-reduced': reduced(),
      }}
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

      {/* Winner podium: crown + three CSS-only confetti bursts. */}
      <Show when={finished() && !reduced()}>
        <div class="rv-confetti" aria-hidden="true">
          <For each={[0, 1, 2]}>
            {(burst) => (
              <div class={`rv-burst rv-burst-${burst}`}>
                <For each={Array.from({ length: 14 }, (_, i) => i)}>
                  {(i) => (
                    <span
                      style={{
                        '--cx': `${(i - 6.5) * 9 + ((burst * 37) % 23)}vw`,
                        '--cd': `${(i * 53 + burst * 97) % 400}ms`,
                        '--cr': `${(i * 137 + burst * 61) % 360}deg`,
                        '--cc': ['#ff2fb4', '#7c3aed', '#ffda57', '#41e6c0', '#ff7a45'][i % 5],
                      }}
                    />
                  )}
                </For>
              </div>
            )}
          </For>
        </div>
      </Show>

      <p class="round-heading">the verdict</p>
      <p class="rv-progress">
        {progress()} revealed · beats play themselves · tap/space = next · hold = skip to winner
      </p>

      <Show
        when={!reduced()}
        fallback={
          /* Reduced-motion fallback: instant ranked list, same Continue control. */
          <div class="rv-list">
            <For each={bestFirst()}>
              {(entry) => (
                <article class="rv-row" data-rank={entry.rank}>
                  <span class="rv-row-rank">#{entry.rank}</span>
                  <span class="rv-row-who">
                    {entry.chicken ? '🐔 ' : ''}
                    {entry.nickname}
                  </span>
                  <span class="rv-row-what">
                    “{entry.title}” — {entry.artist}
                  </span>
                  <strong class="rv-row-score">{entry.score}/100</strong>
                  <p class="rv-row-why">{entry.explanation}</p>
                </article>
              )}
            </For>
            <Show when={total() > 0}>
              <button
                type="button"
                class="btn-primary btn-start"
                disabled={props.busy}
                onClick={(e) => {
                  e.stopPropagation();
                  continueToLeaderboard();
                }}
              >
                {props.busy ? 'Closing…' : 'Continue ▶'}
              </button>
            </Show>
          </div>
        }
      >
        <Show
          when={beat() > 0}
          fallback={
            <div class="rv-drumroll" role="status">
              <div class="rv-drum-ring" aria-hidden="true" />
              <p class="scenario-big">who nailed it?</p>
              <p class="hint">worst to best, played automatically — brace for last place 💀</p>
              <button
                type="button"
                class="btn-primary btn-start"
                disabled={props.busy || total() === 0}
                onClick={(e) => {
                  e.stopPropagation();
                  advance();
                }}
              >
                Start the countdown ▶
              </button>
            </div>
          }
        >
          <Show when={current()} fallback={<div class="rv-card rv-pending">…</div>}>
            {(entry) => (
              <>
                {/* Freeze zone: blurred ghosts of the remaining top spots pulse
                    (heartbeat) until their beats come due. */}
                <Show when={freezeZone()}>
                  <div class="rv-ghosts" aria-hidden="true">
                    <For each={Array.from({ length: ghosts() }, (_, i) => i)}>
                      {() => <div class="rv-ghost">?</div>}
                    </For>
                  </div>
                </Show>

                <article
                  class={`rv-card ${ordinalClass(beat())}`}
                  data-rank={entry().rank}
                  style={beatDurVar(beat())}
                >
                  <p class="rv-rank">{beat() === total() ? '🏆' : `#${entry().rank}`}</p>
                  <h3 class="rv-title">“{entry().title}”</h3>
                  <p class="rv-artist">{entry().artist}</p>
                  <strong class="rv-score">{entry().score}/100</strong>
                  <Show when={beat() === total()}>
                    <p class="rv-crown" aria-hidden="true">
                      👑
                    </p>
                  </Show>
                  <p class="rv-owner">
                    played by {entry().chicken ? '🐔 ' : ''}
                    <strong>{entry().nickname}</strong>
                  </p>
                  <p class="rv-explanation">{entry().explanation}</p>
                </article>

                <Show when={finished() && hasFull()}>
                  <button
                    type="button"
                    class="btn-primary btn-start"
                    disabled={props.busy}
                    onClick={(e) => {
                      e.stopPropagation();
                      continueToLeaderboard();
                    }}
                  >
                    {props.busy ? 'Closing…' : 'Continue ▶'}
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
