/**
 * Phase-0 server tests: token crypto + rate limiter behavior.
 * Negative authZ cases land with routes in Phase 1 (tracked in TASKS.md).
 */
import { describe, expect, it } from 'vitest';
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
});
