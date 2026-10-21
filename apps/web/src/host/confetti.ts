export const GAME_OVER_CONFETTI_MS = 3_600;

export interface ConfettiTimers {
  set: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clear: (timer: ReturnType<typeof setTimeout>) => void;
}

/** Schedule DOM removal and return an early-unmount cancellation hook. */
export function startConfettiLifecycle(
  hide: () => void,
  durationMs = GAME_OVER_CONFETTI_MS,
  timers: ConfettiTimers = {
    // Safari/WebKit requires Window timer methods to retain their receiver.
    set: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clear: (timer) => globalThis.clearTimeout(timer),
  },
): () => void {
  const timer = timers.set(hide, durationMs);
  return () => timers.clear(timer);
}
