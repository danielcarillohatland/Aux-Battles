/**
 * Local record of *my* submission for the current room+round (Phase 3).
 *
 * Why local state at all: the snapshot only says `you.hasSubmitted` — it never
 * says whether the submission was MINE or a server-side CHICKEN 🐔 random
 * assignment after timer expiry. We derive that by remembering what we picked:
 *
 *   hasSubmitted=true  +  local pick for this round  → SEALED (I chose)
 *   hasSubmitted=true  +  no local pick this round   → CHICKEN (server chose)
 *
 * Persisted to localStorage so a refresh mid-round keeps you sealed instead of
 * misreading your own earlier lock as a chicken assignment.
 */
import type { Track } from '@aux/shared';

export interface SubmissionRecord {
  roundIdx: number;
  track: Track | null; // null ⇒ reserved (unused today; chicken is derived, not stored)
  clientMsgId: string;
}

const KEY_PREFIX = 'aux:submission';

const key = (code: string) => `${KEY_PREFIX}:${code.toUpperCase()}`;

export function loadSubmission(code: string): SubmissionRecord | null {
  try {
    const raw = localStorage.getItem(key(code));
    if (!raw) return null;
    const s = JSON.parse(raw) as Partial<SubmissionRecord>;
    if (
      typeof s.roundIdx === 'number' &&
      typeof s.clientMsgId === 'string' &&
      s.clientMsgId.length >= 8 &&
      (s.track === null || (typeof s.track === 'object' && s.track !== null))
    ) {
      return { roundIdx: s.roundIdx, track: s.track ?? null, clientMsgId: s.clientMsgId };
    }
    return null;
  } catch {
    return null;
  }
}

export function saveSubmission(code: string, record: SubmissionRecord): void {
  try {
    localStorage.setItem(key(code), JSON.stringify(record));
  } catch {
    /* private mode etc. — sealing still works this tab */
  }
}

/** Round rolled over → last round's record must never seal the new one. */
export function clearSubmissionIfStale(code: string, roundIdx: number): void {
  const rec = loadSubmission(code);
  if (rec && rec.roundIdx !== roundIdx) removeStaleSubmission(code);
}

export function removeStaleSubmission(code: string): void {
  try {
    localStorage.removeItem(key(code));
  } catch {
    /* ignore */
  }
}
