/**
 * Join-URL derivation for the host QR code.
 *
 * Phones interpret 127.0.0.1/localhost as THEMSELVES, so a QR built from
 * `location.origin` is unreachable when the host page runs on localhost —
 * which it always does in dev (Vite) and often in prod-behind-proxy setups.
 *
 * Resolution order:
 *  1. `?joinOrigin=` override (host can paste a known-good origin)
 *  2. AUX join-origin discovery: any hostname already reachable by the host
 *     that is NOT loopback — LAN IP, LAN hostname, or deployed domain.
 *  3. Fallback: location.origin (only correct when the host itself is on a
 *     LAN-reachable address).
 */

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0']);

function isLoopback(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  return LOOPBACK.has(h) || h.startsWith('127.');
}

/** The hostname of the current page, loopback-qualified for readability. */
export function currentOriginInfo(): { host: string; isLoopback: boolean } {
  const host = window.location.hostname;
  return { host, isLoopback: isLoopback(host) };
}

/**
 * Build the phone-reachable player URL for a room code.
 * @param code   room code
 * @param origin optional explicit base origin (wins over everything)
 */
export function buildJoinUrl(code: string, origin?: string): string {
  const base = origin ?? window.location.origin;
  return `${base.replace(/\/$/, '')}/player.html?code=${encodeURIComponent(code)}`;
}

/**
 * Best-effort join origin: returns null while the host page is on a loopback
 * address AND no explicit origin was given — callers show a hint instead of
 * an unreachable QR. Non-loopback hosts (LAN IP, deployed domain) pass through.
 */
export function resolveJoinOrigin(explicit?: string | null): string | null {
  if (explicit && explicit.trim() !== '') return explicit.trim().replace(/\/$/, '');
  const { isLoopback } = currentOriginInfo();
  return isLoopback ? null : window.location.origin;
}
