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

/** `judge` picks the scoring mode when the server offers open AI access. */
export const CreateRoomRequestSchema = z
  .object({ judge: z.enum(['ai', 'crowd']).optional() })
  .strict();
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
  /** Catalog provenance. `original` remains readable for old room checkpoints. */
  source: z.enum(['original', 'licensed', 'apple_music', 'deezer', 'youtube', 'manual']).optional(),
  /**
   * Length of the audio the host actually plays when it is shorter than the
   * recording (30-second preview clips). The excerpt window is chosen from it.
   */
  playableMs: z.number().int().positive().optional(),
  /** Sonic profile supplied to players and the judge for unfamiliar originals. */
  description: z.string().min(1).max(240).optional(),
  /** Human-readable credit supplied by the approved catalog. */
  attribution: z.string().min(1).max(160).optional(),
  /** Server-issued, host-authenticated endpoint. Stripped from player submissions. */
  playbackUrl: z.string().startsWith('/api/v1/').max(300).optional(),
  /** First-party provider page shown beside provider-backed playback. */
  externalUrl: z.string().url().max(500).optional(),
  /**
   * Ordered fallback video ids for embedded playback (D-028). The API cannot
   * prove a video plays in an iframe, so the host tries these in turn.
   */
  videoCandidates: z
    .array(z.string().regex(/^[A-Za-z0-9_-]{11}$/))
    .max(6)
    .optional(),
});
export type Track = z.infer<typeof TrackSchema>;

export const SearchRequestSchema = z.object({ query: z.string().trim().min(1).max(120) });

/** Optional one-liner the player writes to argue for their pick (D-026). */
export const DEFENSE_MAX = 160;
export const DefenseSchema = z.string().trim().max(DEFENSE_MAX);

export const SubmissionRequestSchema = z.object({
  clientMsgId: ClientMsgIdSchema,
  track: TrackSchema,
  defense: DefenseSchema.optional(),
});

// ── REST responses / lobby state ─────────────────────────────────────────────

/** Opaque per-player auth token; min length guards against truncation accidents. */
const TokenSchema = z.string().min(20);

export const CreateRoomResponseSchema = z.object({
  code: RoomCodeSchema,
  hostToken: TokenSchema,
  playerId: z.string().min(8),
});
export type CreateRoomResponse = z.infer<typeof CreateRoomResponseSchema>;

export const JoinResponseSchema = z.object({
  playerToken: TokenSchema,
  playerId: z.string().min(8),
  nickname: NicknameSchema,
});
export type JoinResponse = z.infer<typeof JoinResponseSchema>;

// ── Snapshots (full-state replace-never-merge, TDD §9) ───────────────────────

export const PublicPlayerSchema = z.object({
  nickname: NicknameSchema,
  connected: z.boolean(),
});
export type PublicPlayer = z.infer<typeof PublicPlayerSchema>;

export const LobbyStateSchema = z.object({
  roomCode: RoomCodeSchema,
  players: z.array(PublicPlayerSchema),
  hostNickname: NicknameSchema,
});
export type LobbyState = z.infer<typeof LobbyStateSchema>;

/**
 * Judge rubric (D-025), total 10: does the song serve this exact moment, does
 * its mood/energy match, what it is actually about (lyrics), whether the sound
 * world fits (genre), plus a wildcard for audacity, humour, and sing-along pull.
 */
export const JudgingCategoriesSchema = z.object({
  scenarioFit: z.number().min(0).max(3),
  mood: z.number().min(0).max(2),
  lyrics: z.number().min(0).max(2),
  genre: z.number().min(0).max(2),
  wildcard: z.number().min(0).max(1),
});
export const JUDGING_CATEGORY_MAX: Readonly<Record<keyof JudgingCategories, number>> = {
  scenarioFit: 3,
  mood: 2,
  lyrics: 2,
  genre: 2,
  wildcard: 1,
};
export type JudgingCategories = z.infer<typeof JudgingCategoriesSchema>;

/** One short sentence per bullet (D-032). */
export const JudgeLineSchema = z.string().min(1).max(160);

/** How much the AI judge actually knew about the song (low = scored mostly neutral). */
export const JudgeConfidenceSchema = z.enum(['high', 'medium', 'low']);
export type JudgeConfidence = z.infer<typeof JudgeConfidenceSchema>;

export const TrackJudgementSchema = z.object({
  totalScore: z.number().min(0).max(10),
  categories: JudgingCategoriesSchema,
  /** Two or three concrete reasons the song fits or misses. */
  reasons: z.array(JudgeLineSchema).min(1).max(3).optional(),
  /** Whether the player's defense actually helped. */
  defenseNote: JudgeLineSchema.optional(),
  /** One decisive closing sentence. */
  verdict: JudgeLineSchema.optional(),
  /** The bullets joined into prose for players and stored results. */
  explanation: z.string().min(1).max(700),
  /** Provenance survives the wire so fallback scores are never presented as AI. */
  judgeModel: z.string().min(1).max(160).optional(),
  confidence: JudgeConfidenceSchema.optional(),
});
export type TrackJudgement = z.infer<typeof TrackJudgementSchema>;

export const SnapshotSchema = z.object({
  roomCode: RoomCodeSchema,
  state: z.enum(FSM_STATES),
  roundIdx: z.number().int().nonnegative(),
  /** Absolute epoch-ms deadline for the current timed phase, or null. Clients render countdowns locally (D-C). */
  phaseEndsAt: z.number().int().nullable(),
  playbackMode: z.enum(PLAYBACK_MODES),
  players: z.array(PublicPlayerSchema),
  submissionsCount: z.number().int().nonnegative(),
  /** Current round content. Optional while older checkpoints are rehydrated. */
  category: z.string().max(80).nullable().optional(),
  scenario: z.string().max(240).nullable().optional(),
  /** The feeling the song should create, shared by players and the judge (null = custom prompt). */
  scenarioVibe: z.string().max(120).nullable().optional(),
  /** Anonymous playback order; ownership is revealed only in `results`. */
  queue: z.array(TrackSchema).optional(),
  playbackIndex: z.number().int().nonnegative().optional(),
  playbackDevice: z.string().max(120).nullable().optional(),
  playbackError: z.string().max(280).nullable().optional(),
  playbackStatus: z.enum(['ready', 'starting', 'playing', 'complete', 'failed']).optional(),
  excerptStartMs: z.number().int().nonnegative().optional(),
  excerptDurationMs: z.number().int().positive().optional(),
  excerptStartedAt: z.number().int().nullable().optional(),
  judgingIndex: z.number().int().nonnegative().optional(),
  judgingCount: z.number().int().nonnegative().optional(),
  judgingStatus: z.enum(['idle', 'listening', 'analyzing', 'revealed', 'voting']).optional(),
  judgingMode: z.enum(['ai', 'crowd']).optional(),
  /** Why the room is voting instead of the AI judge (null = chosen crowd play). */
  judgeNotice: z.enum(['off_duty', 'unavailable']).nullable().optional(),
  judgingCompleted: z.number().int().nonnegative().optional(),
  crowdVote: z
    .object({
      ballotId: z.string(),
      options: z.array(z.object({ id: z.string(), track: TrackSchema })),
      eligible: z.boolean(),
      voted: z.boolean(),
      received: z.number().int().nonnegative(),
      eligibleCount: z.number().int().nonnegative(),
      closesAt: z.number().int(),
      canClose: z.boolean(),
      tiePolicy: z.string(),
    })
    .nullable()
    .optional(),
  judgingTrack: TrackSchema.nullable().optional(),
  /** The anonymous defense written by whoever picked the track under review. */
  judgingDefense: z.string().max(DEFENSE_MAX).nullable().optional(),
  judgingResult: TrackJudgementSchema.nullable().optional(),
  results: z
    .array(
      z.object({
        rank: z.number().int().positive(),
        score: z.number().int().min(0).max(100),
        explanation: z.string().max(700),
        judgeModel: z.string().min(1).max(160).optional(),
        reasons: z.array(JudgeLineSchema).min(1).max(3).optional(),
        defenseNote: JudgeLineSchema.optional(),
        verdict: JudgeLineSchema.optional(),
        defense: z.string().max(DEFENSE_MAX).optional(),
        categories: JudgingCategoriesSchema.optional(),
        totalScore: z.number().min(0).max(10).optional(),
        confidence: JudgeConfidenceSchema.optional(),
        track: TrackSchema,
        owner: NicknameSchema,
        chicken: z.boolean(),
      }),
    )
    .optional(),
  resultCount: z.number().int().nonnegative().optional(),
  revealIndex: z.number().int().nonnegative().optional(),
  leaderboard: z
    .array(
      z.object({
        playerId: z.string(),
        nickname: NicknameSchema,
        totalScore: z.number().int(),
        wins: z.number().int().nonnegative(),
      }),
    )
    .optional(),
  you: z.object({
    role: z.enum(['host', 'player']),
    hasSubmitted: z.boolean(),
    nickname: NicknameSchema.nullable(),
  }),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

// ── Phase 4: judgement payloads ───────────────────────────────────────────────

/** One ranked entry of the round verdict, delivered by the WS `judgement` frame. */
export const JudgementResultSchema = z.object({
  rank: z.number().int().positive(),
  score: z.number().int().min(0).max(100),
  title: z.string().min(1).max(80),
  artist: z.string().min(1).max(80),
  explanation: z.string().max(700),
  /** Owner nickname — anonymity ends here; this payload ships only post-judging. */
  nickname: NicknameSchema,
});
export type JudgementResult = z.infer<typeof JudgementResultSchema>;

/** Full round ranking, computed once by the judge and broadcast to hosts. */
export const JudgementPayloadSchema = z.object({
  results: z.array(JudgementResultSchema).min(1),
});
export type JudgementPayload = z.infer<typeof JudgementPayloadSchema>;

// ── WebSocket frames ({t, ts, seq} envelope) ─────────────────────────────────

const FrameBase = z.object({ ts: z.number().int(), seq: z.number().int() });

/** Server → client. `state_change` carries a full snapshot; everything else is informational. */
export const ServerFrameSchema = z.discriminatedUnion('t', [
  FrameBase.extend({ t: z.literal('state_change'), snapshot: SnapshotSchema }),
  FrameBase.extend({ t: z.literal('timer_tick'), phaseEndsAt: z.number().nullable() }),
  FrameBase.extend({ t: z.literal('submission_received'), count: z.number().int() }),
  FrameBase.extend({ t: z.literal('playback_cue') }), // host-only; payload lands Phase 2.5
  /** Judging complete → full verdict; payload present whenever a round was judged. */
  FrameBase.extend({ t: z.literal('judgement'), payload: JudgementPayloadSchema.optional() }),
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
