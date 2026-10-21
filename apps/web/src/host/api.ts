import { requestWithDeadline } from '../config/request.js';
/**
 * AUX BATTLES — host REST client.
 * Every response uses the shared {ok,data} / {ok,error} envelope (@aux/shared).
 * Failures throw HostApiError with a stable code; UI maps codes to copy in errors.ts.
 */
import type { ErrorCode } from '@aux/shared';
import { apiUrl } from '../config/endpoints.js';

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
  // Only send a JSON content-type when there IS a JSON body — Fastify rejects
  // `application/json` requests with an empty body (FST_ERR_CTP_EMPTY_JSON_BODY),
  // which broke bodyless POSTs like Create Room.
  const hasJsonBody = typeof init?.body === 'string';
  let res: Response;
  try {
    res = await requestWithDeadline(apiUrl(path), {
      ...init,
      headers: {
        ...(hasJsonBody ? { 'content-type': 'application/json' } : {}),
        ...(init?.headers as Record<string, string> | undefined),
      },
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
