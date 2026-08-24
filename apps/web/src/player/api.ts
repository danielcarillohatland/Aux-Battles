/**
 * Player-side API access (TDD §5 envelope contract).
 * Every REST response is `{ ok: true, data }` or `{ ok: false, error: { code, message } }`
 * with codes from @aux/shared — part of the wire contract, matched precisely here.
 */
import { LobbyStateSchema } from '@aux/shared';
import type { PlayerSession } from './session.js';

/** Personality-first, short — errors.ts copy lives client-side too (TDD §9). */
export type JoinFailure =
  | { kind: 'name_taken' }
  | { kind: 'room_not_found' }
  | { kind: 'rate_limited'; retryAfterS: number }
  | { kind: 'other'; message: string };

export type JoinResult = { ok: true; session: PlayerSession } | { ok: false; failure: JoinFailure };

const DEFAULT_RATE_LIMIT_RETRY_S = 30;

/** Wire envelope shape (D-D): discriminated by `ok`. Parsed leniently, validated via Zod downstream. */
type WireEnvelope =
  | { ok: true; data: unknown }
  | { ok: false; error?: { code?: string; message?: string; details?: Record<string, unknown> } };

function readEnvelope(res: Response): Promise<WireEnvelope | null> {
  return res
    .json()
    .then((j) => (j && typeof j === 'object' && 'ok' in j ? (j as WireEnvelope) : null))
    .catch(() => null);
}

export async function joinRoom(code: string, nickname: string): Promise<JoinResult> {
  let res: Response;
  try {
    res = await fetch(`/api/v1/rooms/${encodeURIComponent(code)}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ code, nickname }),
    });
  } catch {
    return {
      ok: false,
      failure: { kind: 'other', message: "couldn't reach the party — check your wifi" },
    };
  }

  const env = await readEnvelope(res);

  if (!res.ok || !env || env.ok !== true || env.data === undefined) {
    const code_ = env?.ok === false ? env.error?.code : undefined;
    const details = env?.ok === false ? env.error?.details : undefined;
    switch (code_) {
      case 'NAME_TAKEN':
        return { ok: false, failure: { kind: 'name_taken' } };
      case 'ROOM_NOT_FOUND':
      case 'ROOM_CLOSED':
        return { ok: false, failure: { kind: 'room_not_found' } };
      case 'RATE_LIMITED': {
        const raw = Number(details?.retryAfterSec ?? details?.retryAfterS);
        const retryAfterS =
          Number.isFinite(raw) && raw > 0 ? Math.ceil(raw) : DEFAULT_RATE_LIMIT_RETRY_S;
        return { ok: false, failure: { kind: 'rate_limited', retryAfterS } };
      }
      default:
        return {
          ok: false,
          failure: {
            kind: 'other',
            message:
              env?.ok === false && env.error?.message
                ? String(env.error.message)
                : 'something broke — try again',
          },
        };
    }
  }

  // Success body: { ok: true, data: { playerToken, playerId, nickname } }
  const data = env.data as Partial<{ playerToken: unknown; playerId: unknown }> | undefined;
  const playerId = typeof data?.playerId === 'string' ? data.playerId : '';
  const playerToken = typeof data?.playerToken === 'string' ? data.playerToken : '';
  if (!playerId || !playerToken) {
    return {
      ok: false,
      failure: { kind: 'other', message: 'the door opened weirdly — try again' },
    };
  }
  return { ok: true, session: { playerId, playerToken, nickname, code } };
}

/** Player count from the public snapshot endpoint; null when the room can't be seen. */
export async function fetchPlayerCount(code: string): Promise<number | null> {
  let res: Response;
  try {
    res = await fetch(`/api/v1/rooms/${encodeURIComponent(code)}/snapshot`, {
      headers: { accept: 'application/json' },
    });
  } catch {
    return null;
  }
  if (res.status === 404) return null; // distinguishable: room gone
  if (!res.ok) return null;
  const env = await readEnvelope(res);
  const data = env?.ok === true ? env.data : null;
  if (!data) return null;
  const parsed = LobbyStateSchema.safeParse(data); // Phase 1 snapshot = lobby shape (A6 finding #1)
  if (parsed.success) return parsed.data.players.length;
  if (Array.isArray((data as { players?: unknown }).players)) {
    return (data as { players: unknown[] }).players.length; // tolerate older shape
  }
  return null;
}

export async function fetchRoomExists(code: string): Promise<boolean | null> {
  const count = await fetchPlayerCount(code);
  return count === null ? null : true;
}
