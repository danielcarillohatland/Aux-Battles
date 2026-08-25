/**
 * TimerService (D-C) — ONE setTimeout per room while a timed phase is armed.
 * No global ticker advancing state (that design was rejected in D-C); idle
 * rooms hold zero timers.
 *
 * Contract:
 *  - arm(key, deadline, onExpire): schedules the callback at the ABSOLUTE
 *    deadline (epoch-ms). Deadlines already in the past fire immediately —
 *    that is exactly what boot sweep needs after a crash: re-arm persisted
 *    deadlines and let expiry re-enter the FSM through its mutex as
 *    TIMER_EXPIRED.
 *  - Re-arming the same key replaces the previous handle; a stale firing
 *    checks its deadline against the live one before acting, so an old timer
 *    can never double-fire after a replacement.
 *  - Timers are unref'd so they never keep the process alive on shutdown.
 */
export interface TimerEntry {
  key: string;
  /** Absolute epoch-ms deadline this timer fires at. */
  deadline: number;
}

interface InternalTimer extends TimerEntry {
  handle: NodeJS.Timeout;
}

export class TimerService {
  private readonly timers = new Map<string, InternalTimer>();

  /**
   * Arm (or re-arm) the timer for `key`. Exactly one live timer per key.
   * Overdue deadlines are fired via setTimeout(0), never synchronously — the
   * FSM mutex must be free to serialize the expiry like any other event.
   */
  arm(key: string, deadline: number, onExpire: () => void): void {
    this.disarm(key);

    const delay = Math.max(0, deadline - Date.now());
    const handle = setTimeout(() => {
      // Ignore if replaced while pending: only the CURRENT deadline may fire.
      const current = this.timers.get(key);
      if (!current || current.deadline !== deadline) return;
      this.timers.delete(key);
      void onExpire();
    }, delay);
    handle.unref();

    this.timers.set(key, { key, deadline, handle });
  }

  disarm(key: string): void {
    const t = this.timers.get(key);
    if (!t) return;
    clearTimeout(t.handle);
    this.timers.delete(key);
  }

  disarmAll(): void {
    for (const t of this.timers.values()) clearTimeout(t.handle);
    this.timers.clear();
  }

  /** Live deadline for a key, or null when nothing is armed. */
  deadlineOf(key: string): number | null {
    return this.timers.get(key)?.deadline ?? null;
  }

  /** All live timers (inspection / tests / boot-sweep reconciliation). */
  entries(): TimerEntry[] {
    return [...this.timers.values()].map(({ key, deadline }) => ({ key, deadline }));
  }

  get size(): number {
    return this.timers.size;
  }
}

/**
 * ~60 s sweeper for TTL/cleanup ONLY (D-C) — empty-room expiry, room hard-cap,
 * zombie sweep. It NEVER advances game state. Returns a stop function.
 */
export function startTtlSweeper(intervalMs: number, tick: () => void): () => void {
  const handle = setInterval(tick, intervalMs);
  handle.unref();
  return () => clearInterval(handle);
}
