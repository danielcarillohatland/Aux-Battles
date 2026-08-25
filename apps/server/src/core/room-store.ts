/**
 * RoomStore — SQLite (WAL) checkpoint persistence behind a narrow interface
 * (TDD §5 crash recovery, §6 data model, D-B, architecture.md §5).
 *
 * Contract (D-B): authoritative game state lives IN MEMORY in RoomManager/FSM.
 * This store only writes and reads document-style snapshots so a crash costs
 * at most the last un-checkpointed transition. It knows NOTHING about rooms'
 * internal shape — `state` is an opaque JSON blob owned by the FSM — which is
 * what keeps the stage-1 Postgres swap a config change, not surgery.
 *
 * Interface stays exactly three verbs + boot-sweep enumeration:
 *   get / put / delete / codes
 *
 * Durability model:
 * - WAL journal mode + `synchronous=NORMAL`: every put() commits to the WAL
 *   before returning (checkpoints are write-ahead per D-B); a process SIGKILL
 *   never corrupts or loses committed snapshots. Only a power loss may drop
 *   the very last commit — accepted residual (restart mid-party ≈ 5 s blip).
 * - Callers checkpoint on EVERY phase transition and EVERY submission
 *   (submissions are user-generated content; losing them is unacceptable).
 * - Lazy rehydration: nothing is loaded at boot except `codes()` (boot sweep);
 *   a room's snapshot is read on first touch after restart.
 */
import Database from 'better-sqlite3';

/** A durable room checkpoint. `state` is opaque here — the FSM owns its shape. */
export interface RoomSnapshot {
  code: string;
  state: unknown;
  /** Monotonic per-room revision, bumped by the store on every put(). */
  version: number;
  /** Epoch-ms of last checkpoint. */
  updatedAt: number;
}

export interface PutOptions {
  /**
   * Optimistic-concurrency guard: fail instead of overwriting if the stored
   * version differs. Single-process MVP doesn't strictly need it (D-G), but
   * keeping CAS in the contract now means the Postgres swap inherits it free,
   * and the DB remains the race backstop per D-B.
   */
  expectedVersion?: number;
  /** Injectable clock (tests). Defaults to Date.now(). */
  now?: number;
}

export interface RoomStore {
  /** Lazy rehydration primitive: read one room's latest snapshot. */
  get(code: string): RoomSnapshot | undefined;
  /** Checkpoint a snapshot. Returns the stored record (with bumped version). */
  put(code: string, state: unknown, opts?: PutOptions): RoomSnapshot;
  /** Evict (TTL sweeper / room close). Returns true if a row existed. */
  delete(code: string): boolean;
  /** Boot sweep: every persisted room code, oldest-updated first. */
  codes(): string[];
  /** Flush WAL and close the handle (graceful shutdown / test teardown). */
  close(): void;
}

/** put() with expectedVersion hit a concurrent/stale write. Maps to a 409-style code upstream. */
export class StaleWriteError extends Error {
  constructor(code: string) {
    super(`stale checkpoint write for room ${code}`);
    this.name = 'StaleWriteError';
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rooms (
  room_code  TEXT PRIMARY KEY,
  json_state TEXT NOT NULL,
  version    INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

interface RoomRow {
  json_state: string;
  version: number;
  updated_at: number;
}

/** Default implementation: document-style snapshot table per arch §5. */
export class SqliteRoomStore implements RoomStore {
  private readonly db: Database.Database;

  private readonly stmtGet: Database.Statement;
  private readonly stmtPut: Database.Statement;
  private readonly stmtDelete: Database.Statement;
  private readonly stmtCodes: Database.Statement;

  /**
   * @param file path to the SQLite database file; ':memory:' for tests.
   *             (Integration tests use tmpfile fixtures per TDD §11.)
   */
  constructor(file: string) {
    this.db = new Database(file);
    // WAL is the whole point (D-B): writers never block readers and committed
    // checkpoints survive SIGKILL. NORMAL is the WAL-recommended sync level.
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(SCHEMA);

    this.stmtGet = this.db.prepare(
      'SELECT json_state, version, updated_at FROM rooms WHERE room_code = ?',
    );
    this.stmtPut = this.db.prepare(`
      INSERT INTO rooms (room_code, json_state, version, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(room_code) DO UPDATE
        SET json_state = excluded.json_state,
            version    = rooms.version + 1,
            updated_at = excluded.updated_at
      RETURNING version, updated_at
    `);
    this.stmtDelete = this.db.prepare('DELETE FROM rooms WHERE room_code = ?');
    this.stmtCodes = this.db.prepare('SELECT room_code FROM rooms ORDER BY updated_at ASC');
  }

  get(code: string): RoomSnapshot | undefined {
    const row = this.stmtGet.get(code) as RoomRow | undefined;
    if (!row) return undefined;
    return {
      code,
      state: JSON.parse(row.json_state) as unknown,
      version: row.version,
      updatedAt: row.updated_at,
    };
  }

  put(code: string, state: unknown, opts: PutOptions = {}): RoomSnapshot {
    const now = opts.now ?? Date.now();
    const json = JSON.stringify(state);

    if (opts.expectedVersion !== undefined) {
      const current = this.stmtGet.get(code) as RoomRow | undefined;
      if (!current || current.version !== opts.expectedVersion) {
        throw new StaleWriteError(code);
      }
    }

    // Fresh rows start at v1; updates bump monotonically inside SQLite, so two
    // racing puts can never land the same version even without the CAS guard.
    const row = this.stmtPut.get(code, json, 1, now) as {
      version: number;
      updated_at: number;
    };
    return { code, state, version: row.version, updatedAt: row.updated_at };
  }

  delete(code: string): boolean {
    const res = this.stmtDelete.run(code);
    return res.changes > 0;
  }

  codes(): string[] {
    return (this.stmtCodes.all() as Array<{ room_code: string }>).map((r) => r.room_code);
  }

  close(): void {
    // TRUNCATE checkpoints the WAL back into the main db file so a copied/
    // backed-up .sqlite alone is complete (single-file backup, arch §5).
    try {
      this.db.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      this.db.close();
    }
  }
}
