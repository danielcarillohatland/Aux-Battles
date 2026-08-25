/**
 * RoomManager — Phase 1 in-memory room registry (TDD §3, D-A, D-B, D-F).
 * One process owns all game state (D-G); the Map-based store here is the same
 * shape the Stage-1 SQLite/Redis swap will sit behind (D-B).
 *
 * Tokens are minted here and ONLY their SHA-256 hashes are stored
 * (security baseline #1). Raw tokens leave this module exactly once, in the
 * create/join responses.
 */
import { randomInt, randomUUID } from 'node:crypto';
import { ROOM_ALPHABET, ROOM_CODE_LENGTH } from '@aux/shared';
import { hashToken, mintToken } from './tokens.js';

/** Default nickname stamped on the host at room creation (renamable later phases). */
const HOST_DEFAULT_NICKNAME = 'Host';

export interface RoomPlayer {
  nickname: string;
  /** SHA-256 of the session token — raw tokens are never stored. */
  tokenHash: string;
  connected: boolean;
  joinedAt: number;
}

export interface Room {
  hostPlayerId: string;
  players: Map<string, RoomPlayer>;
  createdAt: number;
}

export interface SerializedRoom {
  hostPlayerId: string;
  players: Array<[string, RoomPlayer]>;
  createdAt: number;
}

export interface CreateRoomResult {
  code: string;
  hostToken: string;
  playerId: string;
}

export interface JoinRoomResult {
  playerToken: string;
  playerId: string;
  nickname: string;
}

export interface SnapshotData {
  roomCode: string;
  players: Array<{ nickname: string; connected: boolean }>;
  hostNickname: string | null;
}

export class RoomNotFoundError extends Error {
  constructor() {
    super('room not found');
    this.name = 'RoomNotFoundError';
  }
}

/** Case-insensitive duplicate among CONNECTED players (D-F). */
export class NameTakenError extends Error {
  constructor() {
    super('nickname already taken');
    this.name = 'NameTakenError';
  }
}

export class JoinClosedError extends Error {
  constructor() {
    super('joining is closed for this phase');
    this.name = 'JoinClosedError';
  }
}

export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  onChanged: ((code: string) => void) | null = null;
  canJoin: ((code: string) => boolean) | null = null;

  private fire(code: string): void {
    try {
      this.onChanged?.(code);
    } catch {
      // Persistence failure never invalidates an already accepted mutation.
    }
  }

  /**
   * Random code from ROOM_ALPHABET × ROOM_CODE_LENGTH (D-A: 31^5 ≈ 28.6M).
   * crypto.randomInt is unbiased over the alphabet; rejection-retry until an
   * unused code is drawn.
   */
  generateCode(): string {
    for (;;) {
      let code = '';
      for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
        code += ROOM_ALPHABET[randomInt(ROOM_ALPHABET.length)];
      }
      if (!this.rooms.has(code)) return code;
    }
  }

  createRoom(now: number = Date.now()): CreateRoomResult {
    const code = this.generateCode();
    const playerId = randomUUID();
    const hostToken = mintToken();
    const room: Room = {
      hostPlayerId: playerId,
      players: new Map([
        [
          playerId,
          {
            nickname: HOST_DEFAULT_NICKNAME,
            tokenHash: hashToken(hostToken),
            connected: true,
            joinedAt: now,
          },
        ],
      ]),
      createdAt: now,
    };
    this.rooms.set(code, room);
    this.fire(code);
    return { code, hostToken, playerId };
  }

  get(code: string): Room | undefined {
    return this.rooms.get(code);
  }

  entries(): Array<[string, Room]> {
    return [...this.rooms.entries()];
  }

  /**
   * Resolve a session-token hash to its room membership (search proxy auth:
   * GET /search carries no room code, so membership is proven by token alone).
   * O(rooms × members) — fine at party scale; swap for a hash index if the
   * room count ever grows past a few hundred live rooms.
   */
  findMemberByTokenHash(tokenHash: string): { code: string; playerId: string } | undefined {
    for (const [code, room] of this.rooms) {
      for (const [playerId, player] of room.players) {
        if (player.tokenHash === tokenHash) return { code, playerId };
      }
    }
    return undefined;
  }

  joinRoom(code: string, nickname: string, now: number = Date.now()): JoinRoomResult {
    const room = this.rooms.get(code);
    if (!room) throw new RoomNotFoundError();
    if (this.canJoin !== null && !this.canJoin(code)) throw new JoinClosedError();

    const candidate = nickname.toLowerCase();
    for (const p of room.players.values()) {
      if (p.connected && p.nickname.toLowerCase() === candidate) throw new NameTakenError();
    }

    const playerId = randomUUID();
    const playerToken = mintToken();
    room.players.set(playerId, {
      nickname,
      tokenHash: hashToken(playerToken),
      connected: true,
      joinedAt: now,
    });
    this.fire(code);
    return { playerToken, playerId, nickname };
  }

  serialize(code: string): SerializedRoom | null {
    const room = this.rooms.get(code);
    if (room === undefined) return null;
    return {
      hostPlayerId: room.hostPlayerId,
      players: [...room.players.entries()].map(([id, player]) => [id, { ...player }]),
      createdAt: room.createdAt,
    };
  }

  hydrate(code: string, payload: SerializedRoom): void {
    if (this.rooms.has(code)) return;
    this.rooms.set(code, {
      hostPlayerId: payload.hostPlayerId,
      players: new Map(payload.players.map(([id, player]) => [id, { ...player }])),
      createdAt: payload.createdAt,
    });
  }

  markChanged(code: string): void {
    if (this.rooms.has(code)) this.fire(code);
  }

  delete(code: string): boolean {
    return this.rooms.delete(code);
  }

  snapshot(code: string): SnapshotData {
    const room = this.rooms.get(code);
    if (!room) throw new RoomNotFoundError();
    return {
      roomCode: code,
      players: [...room.players.entries()]
        .filter(([id]) => id !== room.hostPlayerId)
        .map(([, p]) => ({ nickname: p.nickname, connected: p.connected })),
      hostNickname: room.players.get(room.hostPlayerId)?.nickname ?? null,
    };
  }
}
