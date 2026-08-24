/**
 * AUX BATTLES — host REST client.
 * Every response uses the shared {ok,data} / {ok,error} envelope (@aux/shared).
 * Failures throw HostApiError with a stable code; UI maps codes to copy in errors.ts.
 */
import type { ErrorCode } from '@aux/shared';

export type HostErrorCode = ErrorCode | 'NETWORK';

export class HostApiError extends Error {
  readonly code: HostErrorCode;
  constructor(code: HostErrorCode, message: string) {
    super(message);
    this.name = 'HostApiError';
    this.code = code;
  }
}

/** Unwraps the response envelope. Network/parse failures become code:'NETWORK'. */
export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      headers: { 'content-type': 'application/json' },
      ...init,
    });
  } catch {
    throw new HostApiError('NETWORK', 'Could not reach the server.');
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new HostApiError('NETWORK', `Server sent garbage (HTTP ${res.status}).`);
  }

  const envelope = body as { ok: boolean; data?: T; error?: { code: ErrorCode; message: string } };
  if (envelope.ok !== true || envelope.data === undefined) {
    const err = 'error' in envelope ? envelope.error : undefined;
    throw new HostApiError(
      err?.code ?? 'INTERNAL',
      err?.message ?? `Request failed (HTTP ${res.status}).`,
    );
  }
  return envelope.data;
}
