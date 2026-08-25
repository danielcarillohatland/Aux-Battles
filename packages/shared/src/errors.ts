/**
 * Stable error-code enum + response envelope (TDD §5).
 * Codes are part of the wire contract — never rename, only add.
 */
export const ERROR_CODES = [
  'NAME_TAKEN',
  'ALREADY_SUBMITTED',
  'ROOM_NOT_FOUND',
  'ROOM_CLOSED',
  'NOT_HOST',
  'NOT_AUTHENTICATED',
  'INVALID_NICKNAME',
  'INVALID_CODE',
  'RATE_LIMITED',
  'INVALID_ACTION',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorEnvelope {
  ok: false;
  error: { code: ErrorCode; message: string; details?: Record<string, unknown> };
}

export interface OkEnvelope<T> {
  ok: true;
  data: T;
}

export type Envelope<T> = OkEnvelope<T> | ErrorEnvelope;

/** Map DB unique-constraint violations to stable codes (TDD §6 race backstop). */
export function constraintToErrorCode(table: 'submissions' | 'players'): ErrorCode {
  return table === 'submissions' ? 'ALREADY_SUBMITTED' : 'NAME_TAKEN';
}

export function apiError(
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): ErrorEnvelope {
  return details === undefined
    ? { ok: false, error: { code, message } }
    : { ok: false, error: { code, message, details } };
}
