/**
 * AUX BATTLES — canonical constants (TDD §4, D-A).
 * Single source of truth; imported by every package. Never duplicate these values.
 */

/** Room-code alphabet (D-A): 31 symbols, ambiguous glyphs excluded (0/O/1/I/L). */
export const ROOM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789' as const;
export const ROOM_CODE_LENGTH = 5;
/** 31^5 ≈ 28.6M keyspace. */
export const ROOM_CODE_KEYSPACE = 31 ** 5;

/** Nickname rules (TDD §10): short, case-insensitive uniqueness enforced server-side. */
export const NICKNAME_MAX = 20;
/** Destination URL / title caps (security baseline #3). */
export const TITLE_MAX = 80;

/** Realtime (D-C/D-D). */
export const HEARTBEAT_INTERVAL_MS = 15_000;
export const RECONNECT_GRACE_MS = 120_000;

/** Phase timing defaults (TDD §4) — host-adjustable at runtime later. */
export const SCENARIO_DISPLAY_MS = 8_000;
export const SONG_SELECTION_MS = 90_000;
export const AI_JUDGING_TIMEOUT_MS = 20_000;

/** Room lifecycle (TDD §3). */
export const ROOM_TTL_MS = 4 * 60 * 60 * 1000;
export const EMPTY_ROOM_TTL_MS = 10 * 60 * 1000;

/** FSM states in canonical order (TDD §4). */
export const FSM_STATES = [
  'LOBBY',
  'CATEGORY',
  'SCENARIO',
  'SONG_SELECTION',
  'LOCKED',
  'PLAYBACK',
  'AI_JUDGING',
  'RESULTS',
  'LEADERBOARD',
  'GAME_OVER',
] as const;

export type FsmState = (typeof FSM_STATES)[number];

/** Playback modes broadcast in every snapshot (D-E). */
export const PLAYBACK_MODES = ['api', 'manual', 'silent'] as const;
export type PlaybackMode = (typeof PLAYBACK_MODES)[number];
