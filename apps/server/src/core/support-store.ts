import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';

export type ReportKind = 'nickname' | 'defense';
export type ReportStatus = 'pending' | 'reviewed' | 'dismissed';
export interface SupportReportInput {
  roomKey: string;
  reporterId: string;
  targetPlayerId: string;
  clientReportId: string;
  kind: ReportKind;
  roundIdx: number | null;
  capturedContent: string;
  details: string;
  alsoBlock: boolean;
}
export interface StoredSupportReport {
  id: string;
  roomKey: string;
  reporterId: string;
  targetPlayerId: string;
  kind: ReportKind;
  roundIdx: number | null;
  capturedContent: string;
  details: string;
  alsoBlock: boolean;
  createdAt: number;
  status: ReportStatus;
  resolutionNote: string | null;
  resolvedAt: number | null;
}
export class ReportConflictError extends Error {
  constructor() {
    super('This report reference was already used for different content.');
  }
}
interface ReportRow {
  id: string;
  room_key: string;
  reporter_id: string;
  target_player_id: string;
  kind: ReportKind;
  round_idx: number | null;
  captured_content: string;
  details: string;
  also_block: number;
  created_at: number;
  status: ReportStatus;
  resolution_note: string | null;
  resolved_at: number | null;
}
const toReport = (row: ReportRow): StoredSupportReport => ({
  id: row.id,
  roomKey: row.room_key,
  reporterId: row.reporter_id,
  targetPlayerId: row.target_player_id,
  kind: row.kind,
  roundIdx: row.round_idx,
  capturedContent: row.captured_content,
  details: row.details,
  alsoBlock: row.also_block === 1,
  createdAt: row.created_at,
  status: row.status,
  resolutionNote: row.resolution_note,
  resolvedAt: row.resolved_at,
});

/** Private moderation evidence. No session tokens, IP addresses or outbound messaging. */
export class SqliteSupportStore {
  private readonly db: Database.Database;
  constructor(
    file: string,
    private readonly now: () => number = Date.now,
  ) {
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS support_reports (
        id TEXT PRIMARY KEY, room_key TEXT NOT NULL, reporter_id TEXT NOT NULL,
        target_player_id TEXT NOT NULL, client_report_id TEXT NOT NULL, request_hash TEXT NOT NULL,
        kind TEXT NOT NULL, round_idx INTEGER, captured_content TEXT NOT NULL, details TEXT NOT NULL,
        also_block INTEGER NOT NULL, created_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', resolution_note TEXT, resolved_at INTEGER,
        UNIQUE(room_key,reporter_id,client_report_id)
      );
      CREATE INDEX IF NOT EXISTS support_reports_status ON support_reports(status,created_at);
      CREATE TABLE IF NOT EXISTS support_room_blocks (
        room_key TEXT NOT NULL, viewer_id TEXT NOT NULL, target_id TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(room_key,viewer_id,target_id)
      );
    `);
  }
  saveReport(input: SupportReportInput): { id: string; created: boolean } {
    const requestHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    return this.db
      .transaction(() => {
        const existing = this.db
          .prepare(
            'SELECT id,request_hash FROM support_reports WHERE room_key=? AND reporter_id=? AND client_report_id=?',
          )
          .get(input.roomKey, input.reporterId, input.clientReportId) as
          { id: string; request_hash: string } | undefined;
        if (existing) {
          if (existing.request_hash !== requestHash) throw new ReportConflictError();
          return { id: existing.id, created: false };
        }
        const id = randomUUID();
        const createdAt = this.now();
        this.db
          .prepare(
            'INSERT INTO support_reports (id,room_key,reporter_id,target_player_id,client_report_id,request_hash,kind,round_idx,captured_content,details,also_block,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
          )
          .run(
            id,
            input.roomKey,
            input.reporterId,
            input.targetPlayerId,
            input.clientReportId,
            requestHash,
            input.kind,
            input.roundIdx,
            input.capturedContent,
            input.details,
            input.alsoBlock ? 1 : 0,
            createdAt,
          );
        if (input.alsoBlock)
          this.db
            .prepare(
              'INSERT OR IGNORE INTO support_room_blocks (room_key,viewer_id,target_id,created_at) VALUES (?,?,?,?)',
            )
            .run(input.roomKey, input.reporterId, input.targetPlayerId, createdAt);
        return { id, created: true };
      })
      .immediate();
  }
  isBlocked(roomKey: string, viewerId: string, targetId: string): boolean {
    return (
      this.db
        .prepare(
          'SELECT 1 FROM support_room_blocks WHERE room_key=? AND viewer_id=? AND target_id=?',
        )
        .get(roomKey, viewerId, targetId) !== undefined
    );
  }
  clearRoomBlocks(roomKey: string): void {
    this.db.prepare('DELETE FROM support_room_blocks WHERE room_key=?').run(roomKey);
  }
  /** Operator-only access: composition root must authenticate any HTTP wrapper. */
  listReports(options: { status?: ReportStatus; limit?: number } = {}): StoredSupportReport[] {
    const limit = Number.isSafeInteger(options.limit)
      ? Math.min(100, Math.max(1, options.limit!))
      : 50;
    const rows = options.status
      ? this.db
          .prepare(
            'SELECT * FROM support_reports WHERE status=? ORDER BY created_at DESC,id DESC LIMIT ?',
          )
          .all(options.status, limit)
      : this.db
          .prepare('SELECT * FROM support_reports ORDER BY created_at DESC,id DESC LIMIT ?')
          .all(limit);
    return (rows as ReportRow[]).map(toReport);
  }
  resolveReport(id: string, input: { status: 'reviewed' | 'dismissed'; note: string }): boolean {
    if (!['reviewed', 'dismissed'].includes(input.status) || input.note.length > 1000)
      throw new Error('Invalid report resolution');
    return (
      this.db
        .prepare('UPDATE support_reports SET status=?,resolution_note=?,resolved_at=? WHERE id=?')
        .run(input.status, input.note, this.now(), id).changes > 0
    );
  }
  close(): void {
    this.db.close();
  }
}
