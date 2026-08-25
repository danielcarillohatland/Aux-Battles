/**
 * SubmissionStore — Phase 3 anonymous submission engine core (TDD §4-§6, D-B/D-D).
 *
 * Authoritative submission state lives IN MEMORY here (D-B), keyed by round
 * identity `code:roundIdx`. The two uniqueness axes of TDD §6 are enforced
 * structurally, mirroring the SQLite UNIQUE indexes the stage-1 swap will add:
 *   - UNIQUE(round_id, player_id)      → one song per player per round
 *   - UNIQUE(round_id, client_msg_id)  → idempotent replays return the original
 *
 * ANONYMITY (D-D): records carry playerId internally (the judge needs it in a
 * later phase), but every externally observable signal this module produces is
 * COUNT-ONLY — callers receive counts and booleans, never who. Nothing here may
 * leak nicknames/playerIds into broadcasts or snapshots.
 *
 * Persistence seam (D-B): the store never touches RoomStore itself. After every
 * mutation it fires `onChanged(code)`; the controller merges serialize(code)
 * into its room checkpoint payload so submissions survive restarts ("callers
 * checkpoint on EVERY submission" — room-store.ts contract). hydrate() restores
 * the exact pre-crash map during lazy rehydration.
 */
import { randomInt } from 'node:crypto';
import type { Track } from '@aux/shared';

/** Composite round identity: rooms own rounds, rounds own submissions. */
export function roundKeyOf(code: string, roundIdx: number): string {
  return `${code}:${roundIdx}`;
}

export interface StoredSubmission {
  /** `${code}:${roundIdx}` */
  roundId: string;
  playerId: string;
  track: Track;
  clientMsgId: string;
  createdAt: number;
  /** True when the server auto-filled this at timer expiry (TDD §4 chicken 🐔). */
  chicken: boolean;
}

export type SubmitStatus = 'stored' | 'replayed';

export interface SubmitResult {
  status: SubmitStatus;
  submission: StoredSubmission;
  /** Count-only, anonymity-safe: how many players have submitted this round. */
  count: number;
}

/** Raised on a second, DIFFERENT clientMsgId from a player who already submitted. */
export class AlreadySubmittedError extends Error {
  constructor(
    readonly roundId: string,
    readonly playerId: string,
  ) {
    super('player already submitted a song for this round');
    this.name = 'AlreadySubmittedError';
  }
}

export interface SubmitInput {
  code: string;
  roundIdx: number;
  playerId: string;
  clientMsgId: string;
  track: Track;
}

/** Checkpoint payload fragment (versioned for forward-compatible swaps). */
export interface SubmissionsPayload {
  version: 1;
  /** roundId → stored submissions, in arrival order. */
  rounds: Record<string, StoredSubmission[]>;
}

/**
 * Hardcoded 20-track party list for the spike's timer-expiry auto-fill
 * (chicken 🐔 picks). Popular, recognizable, family-safe. Swap for a
 * SearchProvider query in a later phase without touching call sites.
 */
export const PARTY_TRACKS: readonly Track[] = [
  { id: 'sp_party_01', title: 'Dancing Queen', artist: 'ABBA', durationMs: 231_000 },
  { id: 'sp_party_02', title: 'Mr. Brightside', artist: 'The Killers', durationMs: 222_000 },
  { id: 'sp_party_03', title: 'Shake It Off', artist: 'Taylor Swift', durationMs: 219_000 },
  {
    id: 'sp_party_04',
    title: 'Uptown Funk',
    artist: 'Mark Ronson ft. Bruno Mars',
    durationMs: 270_000,
  },
  { id: 'sp_party_05', title: 'Bohemian Rhapsody', artist: 'Queen', durationMs: 355_000 },
  { id: 'sp_party_06', title: 'Hey Ya!', artist: 'OutKast', durationMs: 245_000 },
  {
    id: 'sp_party_07',
    title: 'I Wanna Dance with Somebody',
    artist: 'Whitney Houston',
    durationMs: 300_000,
  },
  { id: 'sp_party_08', title: 'September', artist: 'Earth, Wind & Fire', durationMs: 215_000 },
  { id: 'sp_party_09', title: "Livin' on a Prayer", artist: 'Bon Jovi', durationMs: 250_000 },
  { id: 'sp_party_10', title: "Don't Stop Believin'", artist: 'Journey', durationMs: 250_000 },
  { id: 'sp_party_11', title: 'Blinding Lights', artist: 'The Weeknd', durationMs: 200_000 },
  { id: 'sp_party_12', title: 'Levitating', artist: 'Dua Lipa', durationMs: 203_000 },
  { id: 'sp_party_13', title: 'Sweet Caroline', artist: 'Neil Diamond', durationMs: 201_000 },
  { id: 'sp_party_14', title: 'Wannabe', artist: 'Spice Girls', durationMs: 173_000 },
  {
    id: 'sp_party_15',
    title: "Can't Stop the Feeling!",
    artist: 'Justin Timberlake',
    durationMs: 236_000,
  },
  { id: 'sp_party_16', title: 'Get Lucky', artist: 'Daft Punk', durationMs: 248_000 },
  { id: 'sp_party_17', title: 'Rolling in the Deep', artist: 'Adele', durationMs: 228_000 },
  { id: 'sp_party_18', title: 'Toxic', artist: 'Britney Spears', durationMs: 199_000 },
  { id: 'sp_party_19', title: 'Crazy in Love', artist: 'Beyoncé ft. Jay-Z', durationMs: 236_000 },
  { id: 'sp_party_20', title: 'Take On Me', artist: 'a-ha', durationMs: 225_000 },
];

function pickRandomTrack(): Track {
  return PARTY_TRACKS[randomInt(PARTY_TRACKS.length)]!;
}

export class SubmissionStore {
  /** roundId → (playerId → submission), insertion-ordered. */
  private readonly byPlayer = new Map<string, Map<string, StoredSubmission>>();
  /** roundId → (clientMsgId → submission) — the idempotency index. */
  private readonly byMsg = new Map<string, Map<string, StoredSubmission>>();

  /**
   * Controller seam (D-B): fired with the ROOM CODE after every mutation so the
   * composition root can merge serialize(code) into its checkpoint payload.
   * Never throws inward — checkpointing must not crash a submission mid-party,
   * matching game-runtimes.ts persist() semantics.
   */
  onChanged: ((code: string) => void) | null = null;

  private round(roundId: string): Map<string, StoredSubmission> {
    let m = this.byPlayer.get(roundId);
    if (m === undefined) {
      m = new Map();
      this.byPlayer.set(roundId, m);
    }
    return m;
  }

  private fire(code: string): void {
    if (this.onChanged === null) return;
    try {
      this.onChanged(code);
    } catch {
      // Checkpoint failure must never break the submit path (see class doc).
    }
  }

  /**
   * Record one player's song for a round. Idempotency first (replays return the
   * ORIGINAL result, TDD §5), then the one-song-per-player rule (409 upstream),
   * then insert as the new round leader for count purposes.
   */
  submit(input: SubmitInput, now: number = Date.now()): SubmitResult {
    const roundId = roundKeyOf(input.code, input.roundIdx);
    const msgIndex = this.byMsg.get(roundId);
    const replay = msgIndex?.get(input.clientMsgId);
    if (replay !== undefined) {
      return { status: 'replayed', submission: replay, count: this.round(roundId).size };
    }

    const players = this.round(roundId);
    if (players.has(input.playerId)) {
      throw new AlreadySubmittedError(roundId, input.playerId);
    }

    const submission: StoredSubmission = {
      roundId,
      playerId: input.playerId,
      track: input.track,
      clientMsgId: input.clientMsgId,
      createdAt: now,
      chicken: false,
    };
    players.set(input.playerId, submission);
    if (msgIndex === undefined) {
      this.byMsg.set(roundId, new Map([[input.clientMsgId, submission]]));
    } else {
      msgIndex.set(input.clientMsgId, submission);
    }
    this.fire(input.code);
    return { status: 'stored', submission, count: players.size };
  }

  /** Count-only view — the ONLY number broadcasts are allowed to carry. */
  count(roundId: string): number {
    return this.byPlayer.get(roundId)?.size ?? 0;
  }

  hasSubmitted(roundId: string, playerId: string): boolean {
    return this.byPlayer.get(roundId)?.has(playerId) ?? false;
  }

  /** Arrival-ordered copies for playback/judging consumers. Internal ids included — NOT wire-safe. */
  list(roundId: string): StoredSubmission[] {
    const m = this.byPlayer.get(roundId);
    return m === undefined ? [] : [...m.values()].map((s) => ({ ...s }));
  }

  /**
   * Timer-expiry path (TDD §4): assign a random popular party track to every
   * listed player who has not submitted, marking each CHICKEN 🐔. The caller
   * passes the CONNECTED players only — disconnected players are skipped, they
   * simply miss the round. Returns only the newly created submissions.
   */
  fillChickens(
    code: string,
    roundIdx: number,
    playerIds: readonly string[],
    now: number = Date.now(),
  ): StoredSubmission[] {
    const roundId = roundKeyOf(code, roundIdx);
    const players = this.round(roundId);
    let msgIndex = this.byMsg.get(roundId);
    const filled: StoredSubmission[] = [];
    for (const playerId of playerIds) {
      if (players.has(playerId)) continue;
      const clientMsgId = `chicken-${roundId}-${playerId}`;
      const submission: StoredSubmission = {
        roundId,
        playerId,
        track: pickRandomTrack(),
        clientMsgId,
        createdAt: now,
        chicken: true,
      };
      players.set(playerId, submission);
      if (msgIndex === undefined) {
        msgIndex = new Map();
        this.byMsg.set(roundId, msgIndex);
      }
      msgIndex.set(clientMsgId, submission);
      filled.push(submission);
    }
    if (filled.length > 0) this.fire(code);
    return filled;
  }

  /** Drop a room's rounds entirely (room close / TTL eviction symmetry). */
  clearRoom(code: string): void {
    for (const roundId of [...this.byPlayer.keys()]) {
      if (roundId.startsWith(`${code}:`)) {
        this.byPlayer.delete(roundId);
        this.byMsg.delete(roundId);
      }
    }
  }

  /** Checkpoint fragment covering every round of this room (embedded by controller). */
  serialize(code: string): SubmissionsPayload {
    const prefix = `${code}:`;
    const rounds: Record<string, StoredSubmission[]> = {};
    for (const [roundId, players] of this.byPlayer) {
      if (!roundId.startsWith(prefix)) continue;
      rounds[roundId] = [...players.values()];
    }
    return { version: 1, rounds };
  }

  /** Restore serialized rounds during lazy rehydration. Replaces prior data for these roundIds. */
  hydrate(payload: SubmissionsPayload | null | undefined): void {
    if (payload === null || payload === undefined || payload.version !== 1) return;
    for (const [roundId, subs] of Object.entries(payload.rounds)) {
      const players = new Map<string, StoredSubmission>();
      const msgs = new Map<string, StoredSubmission>();
      for (const sub of subs) {
        players.set(sub.playerId, sub);
        msgs.set(sub.clientMsgId, sub);
      }
      this.byPlayer.set(roundId, players);
      this.byMsg.set(roundId, msgs);
    }
  }
}
