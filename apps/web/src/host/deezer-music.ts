/**
 * Host-side Deezer preview client. The server's room-bound endpoint resolves a
 * fresh, short-lived CDN clip url (D-023); the browser's <audio> element plays
 * it directly, so no audio ever flows through AUX BATTLES.
 */
import { apiUrl } from '../config/endpoints.js';

export interface DeezerPreview {
  previewUrl: string;
  /** Epoch milliseconds after which the signed url stops working, if known. */
  expiresAt: number | null;
  previewMs: number;
}

/** Parse the `{ok,data}` envelope; anything but a fresh https clip url is an error. */
export function parseDeezerPreview(body: unknown): DeezerPreview {
  const envelope = body as {
    ok?: unknown;
    data?: unknown;
    error?: { message?: unknown };
  } | null;
  if (envelope?.ok !== true || typeof envelope.data !== 'object' || envelope.data === null) {
    const message = envelope?.error?.message;
    throw new Error(typeof message === 'string' ? message : 'Deezer preview unavailable');
  }
  const data = envelope.data as Record<string, unknown>;
  const previewUrl = typeof data.previewUrl === 'string' ? data.previewUrl : '';
  if (!previewUrl.startsWith('https://')) {
    throw new Error('Deezer returned no playable preview for this song');
  }
  const expiresAt =
    typeof data.expiresAt === 'number' && Number.isFinite(data.expiresAt) ? data.expiresAt : null;
  const previewMs =
    typeof data.previewMs === 'number' && data.previewMs > 0 ? data.previewMs : 30_000;
  return { previewUrl, expiresAt, previewMs };
}

export async function fetchDeezerPreview(
  playbackUrl: string,
  hostToken: string,
  signal?: AbortSignal,
): Promise<DeezerPreview> {
  let response: Response;
  try {
    response = await fetch(apiUrl(playbackUrl), {
      headers: { authorization: `Bearer ${hostToken}`, accept: 'application/json' },
      cache: 'no-store',
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error('Could not reach the server for the Deezer preview.');
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // A non-JSON failure surfaces through the status check below.
  }
  if (!response.ok) {
    const message = (body as { error?: { message?: unknown } } | null)?.error?.message;
    throw new Error(
      typeof message === 'string' ? message : `Deezer preview request failed (${response.status})`,
    );
  }
  return parseDeezerPreview(body);
}
