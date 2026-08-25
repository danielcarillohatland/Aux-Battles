/**
 * Connect tickets (TDD §10 item 6, D-D): short-lived ONE-TIME credentials that
 * gate the WebSocket upgrade so long-lived session tokens never appear in a
 * query string (access logs, proxies, browser history).
 *
 * Flow:
 *   1. POST /api/v1/ws-ticket — session token travels in the Authorization
 *      header; the server authenticates and mints a ticket bound server-side
 *      to (room code, player id, role, nickname).
 *   2. GET /ws?room=…&ticket=… — the upgrade handler CONSUMES the ticket
 *      atomically: a replay, an unknown ticket, one older than TICKET_TTL_MS,
 *      or one presented for a different room is rejected.
 *
 * Storage discipline mirrors tokens.ts: only SHA-256 hashes of ticket values
 * are kept — a read of this table alone cannot mint a working credential.
 */
import { mintToken, hashToken } from './tokens.js';

/** Tickets live 60 s — enough for the immediate follow-up WS dial, nothing more. */
export const TICKET_TTL_MS = 60_000;

export type WsRole = 'host' | 'player';

/** Identity a consumed ticket grants on the socket. Derived ONLY from tokens. */
export interface TicketGrant {
  code: string;
  playerId: string;
  role: WsRole;
  nickname: string | null;
}

interface StoredTicket extends TicketGrant {
  expiresAt: number;
}

export class ConnectTicketStore {
  private readonly tickets = new Map<string, StoredTicket>();

  /**
   * Mint a fresh single-use ticket for `grant`. Any previous outstanding
   * ticket for the same (code, playerId) is invalidated so stale tabs in a
   * reconnect loop can't pile up unbounded.
   */
  issue(grant: TicketGrant, now: number = Date.now()): string {
    for (const [hash, stored] of this.tickets) {
      if (stored.code === grant.code && stored.playerId === grant.playerId) {
        this.tickets.delete(hash);
      }
    }
    const ticket = mintToken();
    this.tickets.set(hashToken(ticket), { ...grant, expiresAt: now + TICKET_TTL_MS });
    return ticket;
  }

  /**
   * Consume a ticket: returns its grant exactly once, else null. Expiry check
   * happens BEFORE deletion is observable — expired and unknown are the same
   * outcome to the caller (never leak which).
   */
  consume(ticket: string, now: number = Date.now()): TicketGrant | null {
    const stored = this.tickets.get(hashToken(ticket));
    if (stored === undefined) return null;
    this.tickets.delete(hashToken(ticket)); // single-use: gone either way
    if (now >= stored.expiresAt) return null;
    // Strip the internal expiry field before handing the grant out.
    const grant: TicketGrant = {
      code: stored.code,
      playerId: stored.playerId,
      role: stored.role,
      nickname: stored.nickname,
    };
    return grant;
  }

  /** Drop every expired ticket (sweeper-friendly; also fine to skip — consume GCs lazily). */
  sweep(now: number = Date.now()): void {
    for (const [hash, stored] of this.tickets) {
      if (now >= stored.expiresAt) this.tickets.delete(hash);
    }
  }

  get size(): number {
    return this.tickets.size;
  }
}
