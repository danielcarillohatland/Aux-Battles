/**
 * WS hub contracts (TDD §5 realtime, D-D read-mostly protocol).
 * The hub is the ONLY writer of WebSocket frames; REST routes and FSM hooks
 * call the WsHub methods, the hub stamps `{t, ts, seq}` envelopes.
 */
import type { ServerFrame, Snapshot } from '@aux/shared';
import type { RoomManager } from '../core/room-manager.js';
import type { WsRole } from '../core/connect-tickets.js';

export type { WsRole };

/** Authenticated socket identity — derived only from session tokens. */
export interface WsViewer {
  playerId: string;
  role: WsRole;
  nickname: string | null;
}

/**
 * Server push payload BEFORE envelope stamping. `DistributiveOmit` keeps the
 * discriminated union intact (a plain Omit would collapse it into one loose
 * object and lose exhaustiveness).
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type PushFrame = DistributiveOmit<ServerFrame, 'ts' | 'seq'>;

export interface WsHubDeps {
  roomManager: RoomManager;
  /**
   * Per-viewer snapshot builder for `state_change` frames (the `you` slice is
   * private per viewer). Defaults to a LOBBY-shaped snapshot from RoomManager;
   * override once FSM wiring lands so pushes carry live game state.
   */
  buildSnapshot?: (code: string, viewer: WsViewer) => Snapshot | null;
}

export interface WsHub {
  /** Full-snapshot push to every connected viewer in the room (per-viewer `you`). */
  broadcastStateChange(code: string): void;
  /** Informational push to every viewer in the room (seq advances even if no sockets). */
  publish(code: string, frame: PushFrame): void;
  /** Host-only push (`playback_cue` per D-D). */
  toHosts(code: string, frame: PushFrame): void;
  /** Push `kicked` then close that player's socket(s). */
  kick(code: string, playerId: string, reason: string): void;
  /** Push `room_closed` to everyone, close all sockets, retire room state. */
  closeRoom(code: string, reason: string): void;
  /** Live connection count (whole hub, or one room). */
  connectionCount(code?: string): number;
  /** Post-init snapshot-builder override (tests / controller FSM wiring). */
  setSnapshotBuilder(builder: NonNullable<import('./types.js').WsHubDeps['buildSnapshot']>): void;
}

// ── Close codes (private 4xxx range; clients branch on these) ────────────────
/** A second socket for the same player arrived; this one was replaced. */
export const CLOSE_SUPERSEDED = 4001;
/** Unparseable / schema-invalid client frame — the pipe stays dumb, violators leave. */
export const CLOSE_BAD_FRAME = 4400;
/** Session ended server-side (kick). */
export const CLOSE_KICKED = 4403;
/** Room closed/expired while sockets were attached. */
export const CLOSE_ROOM_CLOSED = 1001;

/** Heartbeat: a client frame must arrive at least every 2×15 s (+grace) or we drop it. */
export const HEARTBEAT_STALE_MS = 15_000 * 2 + 2_000;
