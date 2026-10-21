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

import { publicAppOrigin } from '../config/endpoints.js';

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
  const base = origin ?? publicAppOrigin() ?? window.location.origin;
  return `${base.replace(/\/$/, '')}/player.html?code=${encodeURIComponent(code)}`;
}

/**
 * Best-effort join origin: returns null while the host page is on a loopback
 * address AND no explicit origin was given — callers show a hint instead of
 * an unreachable QR. Non-loopback hosts (LAN IP, deployed domain) pass through.
 */
export function resolveJoinOrigin(explicit?: string | null): string | null {
  if (explicit && explicit.trim() !== '') return explicit.trim().replace(/\/$/, '');
  const configured = publicAppOrigin();
  if (configured !== null) return configured;
  const { isLoopback } = currentOriginInfo();
  return isLoopback ? null : window.location.origin;
}

/**
 * YouTube's embedded player returns error 150 ("uploader does not allow
 * embedding") for EVERY video when the parent page's origin is a bare IP
 * address such as 127.0.0.1 or 192.168.0.122; hostnames (localhost, Name.local,
 * a real domain) play fine. The host screen must therefore be opened by name.
 */
export function isIpAddressHost(hostname: string): boolean {
  const h = hostname.trim();
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(h) || /^\[?[0-9a-f:]*:[0-9a-f:]*\]?$/i.test(h);
}

/** Same page on an embed-safe hostname, for the fix-it link in the host UI. */
export function embedSafeHostUrl(
  location: Pick<Location, 'protocol' | 'port' | 'pathname'>,
): string {
  const port = location.port ? `:${location.port}` : '';
  return `${location.protocol}//localhost${port}${location.pathname}`;
}
