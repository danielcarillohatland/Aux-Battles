/**
 * Session tokens (security baseline #1, TDD §3): server-minted, ≥128-bit,
 * constant-time compared. Identity/role derive ONLY from these — never from payloads.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const TOKEN_BYTES = 32; // 256-bit

export function mintToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('base64url');
}

/** Constant-time comparison of a presented token against a stored hash. */
export function verifyToken(presented: string, storedHash: string): boolean {
  const presentedHash = Buffer.from(hashToken(presented));
  const expected = Buffer.from(storedHash);
  if (presentedHash.length !== expected.length) return false;
  return timingSafeEqual(presentedHash, expected);
}
