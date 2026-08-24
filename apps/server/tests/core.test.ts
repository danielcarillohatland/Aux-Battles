/**
 * Phase-0 server tests: token crypto + rate limiter behavior.
 * Negative authZ cases land with routes in Phase 1 (tracked in TASKS.md).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hashToken, mintToken, verifyToken } from '../src/core/tokens.js';
import { createRateLimiter } from '../src/core/rate-limit.js';

describe('tokens', () => {
  it('mints distinct unguessable tokens', () => {
    const a = mintToken();
    const b = mintToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(40); // 256-bit base64url
  });

  it('verifies roundtrip and rejects wrong tokens', () => {
    const t = mintToken();
    const h = hashToken(t);
    expect(verifyToken(t, h)).toBe(true);
    expect(verifyToken(mintToken(), h)).toBe(false);
    expect(verifyToken('', h)).toBe(false);
  });

  it('hashes deterministically and never stores raw tokens', () => {
    expect(hashToken('abc')).toBe(hashToken('abc'));
    expect(hashToken('abc')).not.toBe('abc');
  });
});

describe('rate limiter', () => {
  it('allows up to max then blocks within window', () => {
    // Fixed window via fake clock injection would be nicer; MVP asserts behavior.
    const rl = createRateLimiter({ windowMs: 60_000, max: 3 });
    expect(rl.take('ip:1.2.3.4')).toBe(true);
    expect(rl.take('ip:1.2.3.4')).toBe(true);
    expect(rl.take('ip:1.2.3.4')).toBe(true);
    expect(rl.take('ip:1.2.3.4')).toBe(false);
    expect(rl.retryAfterSecs('ip:1.2.3.4')).toBeGreaterThan(0);
  });

  it('isolates buckets by key', () => {
    const rl = createRateLimiter({ windowMs: 60_000, max: 1 });
    expect(rl.take('join:5.5.5.5')).toBe(true);
    expect(rl.take('join:6.6.6.6')).toBe(true); // different IP, unaffected
  });

  // Carried Phase-0 review finding #3: window expiry under a controlled clock.
  // The limiter reads Date.now() directly (no clock injection yet), so we mock
  // the clock instead of sleeping real time.
  describe('window expiry (fake clock)', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('admits again after windowMs elapses and retryAfterSecs returns 0', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

      const rl = createRateLimiter({ windowMs: 60_000, max: 1 });
      expect(rl.take('ip:1.2.3.4')).toBe(true);
      expect(rl.take('ip:1.2.3.4')).toBe(false);
      expect(rl.retryAfterSecs('ip:1.2.3.4')).toBeGreaterThan(0);

      // Advance past the window: every hit has aged out…
      vi.setSystemTime(new Date('2026-01-01T00:01:00.001Z'));

      // …so a slot is free NOW: Retry-After must not contradict take().
      expect(rl.retryAfterSecs('ip:1.2.3.4')).toBe(0);
      expect(rl.take('ip:1.2.3.4')).toBe(true);
    });

    it('keeps blocking just before expiry', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

      const rl = createRateLimiter({ windowMs: 60_000, max: 1 });
      expect(rl.take('join:5.5.5.5')).toBe(true);
      vi.setSystemTime(new Date('2026-01-01T00:00:59.999Z'));
      expect(rl.take('join:5.5.5.5')).toBe(false);
      expect(rl.retryAfterSecs('join:5.5.5.5')).toBeGreaterThan(0);
    });
  });
});
