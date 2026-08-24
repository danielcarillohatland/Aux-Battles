/**
 * In-memory sliding-window rate limiter (TDD §10 item 5).
 * MVP scope: per-process buckets keyed by `${bucket}:${key}`.
 * Stage-1 swap target: Redis — call sites unchanged (same pattern as RoomStore, D-B).
 */
export interface RateLimiter {
  /** Consume one slot; false = over limit for this window. */
  take(key: string): boolean;
  /** Seconds until the next slot frees (for Retry-After semantics). */
  retryAfterSecs(key: string): number;
}

interface Window {
  hits: number[];
}

export function createRateLimiter(opts: { windowMs: number; max: number }): RateLimiter {
  const { windowMs, max } = opts;
  const windows = new Map<string, Window>();
  let lastGcAt = 0;

  function prune(w: Window, now: number): void {
    const cutoff = now - windowMs;
    while (w.hits.length > 0 && (w.hits[0] ?? 0) <= cutoff) w.hits.shift();
  }

  return {
    take(key: string): boolean {
      const now = Date.now();
      let w = windows.get(key);
      if (!w) {
        w = { hits: [] };
        windows.set(key, w);
      }
      prune(w, now);
      if (w.hits.length >= max) return false;
      w.hits.push(now);
      // Opportunistic GC: drop long-dead buckets so the map cannot grow unbounded.
      // Throttled to once per window — otherwise once size crosses the threshold
      // EVERY take() pays an O(n) scan of the whole map.
      if (windows.size > 10_000 && now - lastGcAt >= windowMs) {
        lastGcAt = now;
        for (const [k, win] of windows) {
          prune(win, now);
          if (win.hits.length === 0 && k !== key) windows.delete(k);
        }
      }
      return true;
    },

    retryAfterSecs(key: string): number {
      const w = windows.get(key);
      if (!w) return 0;
      // Prune first: once every hit has aged out of the window a slot is free
      // NOW — reporting a positive Retry-After here would contradict take(),
      // which would admit the request immediately.
      prune(w, Date.now());
      if (w.hits.length < max) return 0;
      const oldest = w.hits[0];
      if (oldest === undefined) return 0;
      return Math.max(1, Math.ceil((oldest + windowMs - Date.now()) / 1000));
    },
  };
}
