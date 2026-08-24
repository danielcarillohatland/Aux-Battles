/**
 * AUX BATTLES — centralized error-code → human copy map (frontend-spec §7).
 * One place to keep the voice funny and consistent. Personality-first, never dead ends.
 */
import type { HostErrorCode } from './api.js';

const ERROR_TEXT: Record<HostErrorCode, string> = {
  NAME_TAKEN: 'That name’s grabbed. Try another.',
  ALREADY_SUBMITTED: 'You already locked a song this round.',
  ROOM_NOT_FOUND: 'That room’s gone cold. Check the code?',
  ROOM_CLOSED: 'The party ended 🎈',
  NOT_HOST: 'Only the host can do that.',
  NOT_AUTHENTICATED: 'Your session slipped out. Rejoin to get back in.',
  INVALID_NICKNAME: 'Nicknames need 1–20 real characters.',
  INVALID_CODE: 'That code doesn’t parse. Check for typos?',
  RATE_LIMITED: 'Whoa, slow down — too many requests.',
  INTERNAL: 'The judge tripped over a cable. Try again.',
  NETWORK: 'Shaky connection… can’t reach the server 🤞',
};

export function errorText(code: HostErrorCode): string {
  return ERROR_TEXT[code] ?? (ERROR_TEXT.INTERNAL as string);
}
