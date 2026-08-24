/**
 * AUX BATTLES — Zod schemas: the single protocol truth (@aux/shared, D-D).
 * Both client apps import from here exclusively; the backend validates against these.
 * WS frame vocabulary is deliberately tiny (D-D): REST mutates, WS informs.
 */
import { z } from 'zod';
import { FSM_STATES, NICKNAME_MAX, PLAYBACK_MODES, ROOM_CODE_LENGTH } from './constants.js';
import { ERROR_CODES } from './errors.js';

// ── Primitives ────────────────────────────────────────────────────────────────

// D-A alphabet minus ambiguous glyphs: A–H, J/K/M/N (L excluded), P–Z, 2–9 = 31 symbols.
const roomCodePattern = new RegExp(`^[A-HJKMNP-Z2-9]{${ROOM_CODE_LENGTH}}$`);

export const RoomCodeSchema = z.string().regex(roomCodePattern, 'invalid room code');
export const NicknameSchema = z.string().trim().min(1).max(NICKNAME_MAX);
export const ClientMsgIdSchema = z.string().min(8).max(64);

// ── REST payloads ─────────────────────────────────────────────────────────────

export const CreateRoomRequestSchema = z.object({}).strict();
export const JoinRequestSchema = z.object({
  code: RoomCodeSchema,
  nickname: NicknameSchema,
});

export const TrackSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(80),
  artist: z.string().min(1).max(80),
  album: z.string().max(80).optional(),
  durationMs: z.number().int().positive().optional(),
  artUrl: z.string().url().optional(),
});
export type Track = z.infer<typeof TrackSchema>;

export const SearchRequestSchema = z.object({ query: z.string().trim().min(1).max(120) });

export const SubmissionRequestSchema = z.object({
  clientMsgId: ClientMsgIdSchema,
  track: TrackSchema,
});

// ── Snapshots (full-state replace-never-merge, TDD §9) ───────────────────────

export const PublicPlayerSchema = z.object({
  nickname: NicknameSchema,
  connected: z.boolean(),
});
export type PublicPlayer = z.infer<typeof PublicPlayerSchema>;

export const SnapshotSchema = z.object({
  roomCode: RoomCodeSchema,
  state: z.enum(FSM_STATES),
  roundIdx: z.number().int().nonnegative(),
  /** Absolute epoch-ms deadline for the current timed phase, or null. Clients render countdowns locally (D-C). */
  phaseEndsAt: z.number().int().nullable(),
  playbackMode: z.enum(PLAYBACK_MODES),
  players: z.array(PublicPlayerSchema),
  submissionsCount: z.number().int().nonnegative(),
  you: z.object({
    role: z.enum(['host', 'player']),
    hasSubmitted: z.boolean(),
    nickname: NicknameSchema.nullable(),
  }),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

// ── WebSocket frames ({t, ts, seq} envelope) ─────────────────────────────────

const FrameBase = z.object({ ts: z.number().int(), seq: z.number().int() });

/** Server → client. `state_change` carries a full snapshot; everything else is informational. */
export const ServerFrameSchema = z.discriminatedUnion('t', [
  FrameBase.extend({ t: z.literal('state_change'), snapshot: SnapshotSchema }),
  FrameBase.extend({ t: z.literal('timer_tick'), phaseEndsAt: z.number().nullable() }),
  FrameBase.extend({ t: z.literal('submission_received'), count: z.number().int() }),
  FrameBase.extend({ t: z.literal('playback_cue') }), // host-only; payload lands Phase 2.5
  FrameBase.extend({ t: z.literal('judgement') }), // payload lands Phase 4
  FrameBase.extend({ t: z.literal('reveal_owner') }), // payload lands Phase 4
  FrameBase.extend({ t: z.literal('room_closed'), reason: z.string() }),
  FrameBase.extend({ t: z.literal('kicked'), reason: z.string() }),
]);
export type ServerFrame = z.infer<typeof ServerFrameSchema>;

/** Client → server. Deliberately near-empty (D-D): mutations go through REST. */
export const ClientFrameSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('ping'), ts: z.number().int() }),
  z.object({ t: z.literal('ack'), ts: z.number().int(), seq: z.number().int() }),
]);
export type ClientFrame = z.infer<typeof ClientFrameSchema>;

// ── Error envelope ────────────────────────────────────────────────────────────

export const ErrorCodeSchema = z.enum(ERROR_CODES);

// ── Analytics (D-010): typed events, NDJSON sink, no external vendor ─────────

export const AnalyticsEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('room_created'), roomId: z.string() }),
  z.object({ type: z.literal('player_joined'), roomId: z.string() }),
  z.object({
    type: z.literal('game_completed'),
    roomId: z.string(),
    rounds: z.number().int(),
    players: z.number().int(),
  }),
  z.object({
    type: z.literal('round_completed'),
    roomId: z.string(),
    durationMs: z.number().int(),
  }),
  z.object({ type: z.literal('host_disconnected'), roomId: z.string() }),
  z.object({ type: z.literal('reconnect'), roomId: z.string() }),
  z.object({ type: z.literal('ai_failure'), roomId: z.string(), stage: z.string() }),
  z.object({ type: z.literal('provider_failure'), roomId: z.string(), op: z.string() }),
  z.object({ type: z.literal('manual_playback_used'), roomId: z.string() }),
]);
export type AnalyticsEvent = z.infer<typeof AnalyticsEventSchema>;

/** Sink record: envelope adds wall-clock ts so the stream is self-describing. */
export const AnalyticsRecordSchema = AnalyticsEventSchema.and(z.object({ ts: z.number().int() }));
export type AnalyticsRecord = z.infer<typeof AnalyticsRecordSchema>;
