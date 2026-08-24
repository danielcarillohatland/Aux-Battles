import { describe, expect, it } from 'vitest';
import {
  ClientFrameSchema,
  CreateRoomResponseSchema,
  JoinResponseSchema,
  LobbyStateSchema,
  NicknameSchema,
  RoomCodeSchema,
  SearchRequestSchema,
  ServerFrameSchema,
  SnapshotSchema,
} from '../src/schemas.js';

const validSnapshot = {
  roomCode: 'A7X2M',
  state: 'SONG_SELECTION',
  roundIdx: 2,
  phaseEndsAt: 1_756_000_000_000,
  playbackMode: 'manual',
  players: [{ nickname: 'Ada', connected: true }],
  submissionsCount: 0,
  you: { role: 'player', hasSubmitted: false, nickname: 'Ada' },
};

describe('RoomCodeSchema', () => {
  it('accepts 5 chars from the 31-symbol alphabet', () => {
    expect(RoomCodeSchema.safeParse('A7X2M').success).toBe(true);
    expect(RoomCodeSchema.safeParse('ZZZZZ').success).toBe(true);
  });

  it('rejects ambiguous glyphs and wrong lengths', () => {
    for (const bad of ['0OIL1', 'AAAA', 'AAAAAA', 'aaaaa', 'A7X2 ']) {
      expect(RoomCodeSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe('NicknameSchema', () => {
  it('trims and enforces length', () => {
    expect(NicknameSchema.parse('  Ada  ')).toBe('Ada');
    expect(NicknameSchema.safeParse('').success).toBe(false);
    expect(NicknameSchema.safeParse('x'.repeat(21)).success).toBe(false);
  });
});

describe('ServerFrameSchema', () => {
  it('parses state_change with a full snapshot', () => {
    const frame = { t: 'state_change', ts: 1, seq: 7, snapshot: validSnapshot };
    const parsed = ServerFrameSchema.parse(frame);
    expect(parsed.t).toBe('state_change');
  });

  it('rejects unknown frame types (protocol drift tripwire)', () => {
    expect(ServerFrameSchema.safeParse({ t: 'resync', lastSeq: 3 }).success).toBe(false);
  });
});

describe('ClientFrameSchema', () => {
  it('allows only ping/ack — mutations are REST-only (D-D)', () => {
    expect(ClientFrameSchema.safeParse({ t: 'ping', ts: 1 }).success).toBe(true);
    for (const hostile of ['vote', 'lock', 'ready', 'submit']) {
      expect(ClientFrameSchema.safeParse({ t: hostile }).success).toBe(false);
    }
  });
});

describe('SnapshotSchema', () => {
  it('rejects FSM states outside the canonical set', () => {
    expect(SnapshotSchema.safeParse({ ...validSnapshot, state: 'VOTE' }).success).toBe(false);
  });

  it('requires phaseEndsAt to be nullable epoch-ms', () => {
    expect(SnapshotSchema.safeParse({ ...validSnapshot, phaseEndsAt: null }).success).toBe(true);
    expect(SnapshotSchema.safeParse({ ...validSnapshot, phaseEndsAt: -5 }).success).toBe(true); // int, schema-level
    expect(SnapshotSchema.safeParse({ ...validSnapshot, phaseEndsAt: 1.5 }).success).toBe(false);
  });
});

describe('SearchRequestSchema', () => {
  it('bounds query length', () => {
    expect(SearchRequestSchema.safeParse({ query: 'blur song 2' }).success).toBe(true);
    expect(SearchRequestSchema.safeParse({ query: '' }).success).toBe(false);
    expect(SearchRequestSchema.safeParse({ query: 'x'.repeat(121) }).success).toBe(false);
  });
});

// ── Phase 1 responses / lobby (@aux/shared) ──────────────────────────────────

describe('CreateRoomResponseSchema', () => {
  const valid = { code: 'A7X2M', hostToken: 't'.repeat(20), playerId: 'p'.repeat(8) };

  it('roundtrips a valid response', () => {
    expect(CreateRoomResponseSchema.parse(valid)).toEqual(valid);
  });

  it('enforces token/playerId minimum lengths', () => {
    expect(
      CreateRoomResponseSchema.safeParse({ ...valid, hostToken: 't'.repeat(19) }).success,
    ).toBe(false);
    expect(CreateRoomResponseSchema.safeParse({ ...valid, playerId: 'p'.repeat(7) }).success).toBe(
      false,
    );
  });

  it('rejects an invalid room code', () => {
    for (const bad of ['0OIL1', 'AAAA', 'aaaaa']) {
      expect(CreateRoomResponseSchema.safeParse({ ...valid, code: bad }).success).toBe(false);
    }
  });
});

describe('JoinResponseSchema', () => {
  const valid = { playerToken: 't'.repeat(20), playerId: 'p'.repeat(8), nickname: 'Ada' };

  it('roundtrips a valid response', () => {
    expect(JoinResponseSchema.parse(valid)).toEqual(valid);
  });

  it('enforces token/playerId minimum lengths', () => {
    expect(JoinResponseSchema.safeParse({ ...valid, playerToken: 't'.repeat(19) }).success).toBe(
      false,
    );
    expect(JoinResponseSchema.safeParse({ ...valid, playerId: 'p'.repeat(7) }).success).toBe(false);
  });

  it('enforces nickname bounds via NicknameSchema', () => {
    expect(JoinResponseSchema.safeParse({ ...valid, nickname: '' }).success).toBe(false);
    expect(JoinResponseSchema.safeParse({ ...valid, nickname: 'x'.repeat(21) }).success).toBe(
      false,
    );
  });
});

describe('LobbyStateSchema', () => {
  const valid = {
    roomCode: 'A7X2M',
    players: [
      { nickname: 'Ada', connected: true },
      { nickname: 'Bruno', connected: false },
    ],
    hostNickname: 'Ada',
  };

  it('roundtrips a valid lobby state', () => {
    expect(LobbyStateSchema.parse(valid)).toEqual(valid);
  });

  it('rejects malformed players entries', () => {
    expect(LobbyStateSchema.safeParse({ ...valid, players: [{ nickname: 'Ada' }] }).success).toBe(
      false,
    );
    expect(
      LobbyStateSchema.safeParse({ ...valid, players: [{ nickname: '', connected: true }] })
        .success,
    ).toBe(false);
  });

  it('rejects an invalid room code', () => {
    for (const bad of ['0OIL1', 'AAA', 'AAAAAA']) {
      expect(LobbyStateSchema.safeParse({ ...valid, roomCode: bad }).success).toBe(false);
    }
  });
});
