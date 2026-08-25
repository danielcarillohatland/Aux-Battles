/**
 * Player-side API access (TDD §5 envelope contract).
 * Every REST response is `{ ok: true, data }` or `{ ok: false, error: { code, message } }`
 * with codes from @aux/shared — part of the wire contract, matched precisely here.
 */
import { LobbyStateSchema, TrackSchema } from '@aux/shared';
import type { Track } from '@aux/shared';
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

// ── Song search (Phase 3, frontend-spec §2.6) ─────────────────────────────────

export type SearchOutcome =
  | { status: 'ok'; tracks: Track[] }
  /** Search proxy not deployed yet (404) or hard-down — UI shows a disabled state. */
  | { status: 'unavailable' }
  | { status: 'error'; message: string };

/** Track shape is parsed leniently: the search endpoint contract may land with either `id`/`artUrl` (@aux/shared) or `trackId`/`albumArt` naming. */
function coerceTrack(raw: unknown): Track | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id : typeof r.trackId === 'string' ? r.trackId : null;
  const title = typeof r.title === 'string' ? r.title : '';
  const artist = typeof r.artist === 'string' ? r.artist : '';
  if (!id || !title || !artist) return null;
  const album = typeof r.album === 'string' ? r.album : undefined;
  const artUrl =
    typeof r.artUrl === 'string'
      ? r.artUrl
      : typeof r.albumArt === 'string'
        ? r.albumArt
        : undefined;
  const durationMs =
    typeof r.durationMs === 'number' && Number.isFinite(r.durationMs) && r.durationMs > 0
      ? Math.round(r.durationMs)
      : undefined;
  const candidate = { id, title, artist, album, durationMs, artUrl };
  const parsed = TrackSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/**
 * `GET /api/v1/search?q=` — provider search proxy (another workstream owns the
 * server side). While it 404s we report `unavailable` so the UI can show its
 * graceful disabled state instead of an error.
 */
export async function searchTracks(query: string): Promise<SearchOutcome> {
  let res: Response;
  try {
    res = await fetch(`/api/v1/search?q=${encodeURIComponent(query)}&limit=10`, {
      headers: { accept: 'application/json' },
    });
  } catch {
    return { status: 'error', message: "couldn't reach search — check your wifi" };
  }
  if (res.status === 404 || res.status === 501) return { status: 'unavailable' };
  if (!res.ok) return { status: 'error', message: 'search hiccupped — try again' };

  const env = await readEnvelope(res);
  if (!env || env.ok !== true) {
    return {
      status: 'error',
      message:
        env?.ok === false && env.error?.message ? String(env.error.message) : 'search failed',
    };
  }
  // Tolerate { data: { tracks } }, { data: { results } }, and bare-array shapes.
  const data = env.data as unknown;
  const list: unknown[] = Array.isArray(data)
    ? data
    : Array.isArray((data as { tracks?: unknown })?.tracks)
      ? (data as { tracks: unknown[] }).tracks
      : Array.isArray((data as { results?: unknown })?.results)
        ? (data as { results: unknown[] }).results
        : [];
  const seen = new Set<string>();
  const tracks: Track[] = [];
  for (const raw of list) {
    const t = coerceTrack(raw);
    if (t && !seen.has(t.id)) {
      seen.add(t.id);
      tracks.push(t);
    }
    if (tracks.length >= 10) break; // spec cap
  }
  return { status: 'ok', tracks };
}

// ── Submissions (Phase 3) ─────────────────────────────────────────────────────

export type SubmitFailure =
  | { kind: 'already_submitted' }
  | { kind: 'wrong_phase' }
  | { kind: 'too_late' }
  | { kind: 'rate_limited'; retryAfterS: number }
  | { kind: 'not_found' }
  | { kind: 'other'; message: string };

export type SubmitResult = { ok: true } | { ok: false; failure: SubmitFailure };

const CLIENT_MSG_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** ≥8 chars per ClientMsgIdSchema; crypto-random so double-taps never collide. */
function makeClientMsgId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let out = 'cm_';
  for (const b of bytes) out += CLIENT_MSG_ID_ALPHABET[b % CLIENT_MSG_ID_ALPHABET.length];
  return out;
}

/**
 * `POST /api/v1/rooms/:code/rounds/:roundIdx/submissions` (playerToken bearer)
 * — the room-code alias for the composite `/rounds/:id/submissions` endpoint.
 * Body is the @aux/shared SubmissionRequestSchema shape; the extra flattened
 * fields are tolerated (zod non-strict strips them).
 */
export async function submitTrack(
  session: PlayerSession,
  track: Track,
  roundIdx: number,
): Promise<SubmitResult> {
  const clientMsgId = makeClientMsgId();
  let res: Response;
  try {
    res = await fetch(
      `/api/v1/rooms/${encodeURIComponent(session.code)}/rounds/${roundIdx}/submissions`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: `Bearer ${session.playerToken}`,
        },
        body: JSON.stringify({
          clientMsgId,
          track,
          // flattened fallbacks for a legacy reader; stripped by zod non-strict:
          trackId: track.id,
          title: track.title,
          artist: track.artist,
          durationMs: track.durationMs,
        }),
      },
    );
  } catch {
    return { ok: false, failure: { kind: 'other', message: "couldn't reach the room — retry" } };
  }

  const env = await readEnvelope(res);
  if (!res.ok || !env || env.ok !== true) {
    const code_ = env?.ok === false ? env.error?.code : undefined;
    switch (code_) {
      case 'ALREADY_SUBMITTED':
        return { ok: false, failure: { kind: 'already_submitted' } };
      case 'WRONG_PHASE':
      case 'INVALID_ACTION':
        return { ok: false, failure: { kind: 'wrong_phase' } };
      case 'TOO_LATE':
        return { ok: false, failure: { kind: 'too_late' } };
      case 'RATE_LIMITED':
        return {
          ok: false,
          failure: { kind: 'rate_limited', retryAfterS: DEFAULT_RATE_LIMIT_RETRY_S },
        };
      case 'ROOM_NOT_FOUND':
      case 'ROOM_CLOSED':
      case 'NOT_AUTHENTICATED':
        return { ok: false, failure: { kind: 'not_found' } };
      default:
        return {
          ok: false,
          failure: {
            kind: 'other',
            message:
              env?.ok === false && env.error?.message
                ? String(env.error.message)
                : 'the lock jammed — try again',
          },
        };
    }
  }
  return { ok: true };
}
