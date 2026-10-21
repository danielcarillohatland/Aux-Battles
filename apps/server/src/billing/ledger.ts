import { createHash, randomBytes, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';

export class BillingError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 403,
  ) {
    super(message);
    this.name = 'BillingError';
  }
}
export interface HostAccount {
  id: string;
  appAccountToken: string;
  credits: number;
  createdAt: number;
}
export interface GameReservation {
  roomCode: string;
  accountId: string;
  status: 'active' | 'completed' | 'refunded';
  maxRounds: number;
  createdAt: number;
  expiresAt: number;
}
export interface AiAttemptUsage {
  costMicros?: number;
  inputTokens?: number;
  outputTokens?: number;
  model?: string;
  promptVersion?: string;
  status?: 'success' | 'failed';
  durationMs?: number;
  errorCode?: string;
}
export interface BillingMetrics {
  attempts: number;
  successes: number;
  failures: number;
  pending: number;
  totalCostMicros: number;
  meanDurationMs: number | null;
  models: Array<{
    model: string | null;
    promptVersion: string | null;
    attempts: number;
    failures: number;
    meanDurationMs: number | null;
  }>;
}
export interface BillingLedgerOptions {
  dailyBudgetMicros?: number;
  monthlyBudgetMicros?: number;
  maxRoundsPerGame?: number;
  hostDailyGames?: number;
  sessionTtlMs?: number;
  trialCredits?: number;
  now?: () => number;
}
interface AccountRow {
  id: string;
  account_token: string;
  credits: number;
  created_at: number;
}
interface GameRow {
  room_code: string;
  account_id: string;
  status: GameReservation['status'];
  max_rounds: number;
  created_at: number;
  expires_at: number;
}
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const SCHEMA = `
CREATE TABLE IF NOT EXISTS billing_accounts (
 id TEXT PRIMARY KEY, subject_hash TEXT NOT NULL UNIQUE, account_token TEXT NOT NULL UNIQUE,
 credits INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS billing_sessions (
 token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES billing_accounts(id), expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS billing_apple_authorizations (
 account_id TEXT NOT NULL REFERENCES billing_accounts(id), token_hash TEXT NOT NULL,
 encrypted_refresh_token TEXT NOT NULL, PRIMARY KEY(account_id,token_hash)
);
CREATE TABLE IF NOT EXISTS billing_challenges (
 id TEXT PRIMARY KEY, nonce_hash TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS billing_games (
 room_code TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES billing_accounts(id),
 status TEXT NOT NULL, max_rounds INTEGER NOT NULL, created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL, refund_reason TEXT
);
CREATE INDEX IF NOT EXISTS billing_games_account ON billing_games(account_id,created_at);
CREATE TABLE IF NOT EXISTS billing_purchases (
 transaction_id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES billing_accounts(id),
 product_id TEXT NOT NULL, credits INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS billing_notifications (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS billing_revocations (transaction_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS billing_ai_attempts (
 id TEXT PRIMARY KEY, room_code TEXT NOT NULL REFERENCES billing_games(room_code),
 reserved_micros INTEGER NOT NULL, charged_micros INTEGER NOT NULL, settled INTEGER NOT NULL DEFAULT 0,
 day TEXT NOT NULL, month TEXT NOT NULL, created_at INTEGER NOT NULL, input_tokens INTEGER, output_tokens INTEGER
);
CREATE INDEX IF NOT EXISTS billing_ai_day ON billing_ai_attempts(day);
CREATE INDEX IF NOT EXISTS billing_ai_month ON billing_ai_attempts(month);
`;
function integer(value: number, label: string, min = 0): number {
  if (!Number.isSafeInteger(value) || value < min) throw new Error(`Invalid ${label}`);
  return value;
}

/** House account behind free AI rooms (`AUX_AI_ACCESS=open`); it never holds credits. */
export const OPEN_AI_ACCOUNT_ID = 'open-access';

/** Durable financial authority. All balance/budget decisions commit in IMMEDIATE transactions. */
export class SqliteBillingLedger {
  private readonly db: Database.Database;
  private readonly now: () => number;
  private readonly deletingAccounts = new Set<string>();
  readonly limits: Required<Omit<BillingLedgerOptions, 'now'>>;
  constructor(file: string, options: BillingLedgerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.limits = {
      dailyBudgetMicros: integer(options.dailyBudgetMicros ?? 5_000_000, 'daily AI budget'),
      monthlyBudgetMicros: integer(options.monthlyBudgetMicros ?? 50_000_000, 'monthly AI budget'),
      maxRoundsPerGame: integer(options.maxRoundsPerGame ?? 5, 'rounds per game', 1),
      hostDailyGames: integer(options.hostDailyGames ?? 10, 'daily games', 1),
      sessionTtlMs: integer(options.sessionTtlMs ?? 7 * 86_400_000, 'session lifetime', 1),
      trialCredits: integer(options.trialCredits ?? 1, 'trial credits'),
    };
    if (this.limits.maxRoundsPerGame !== 5)
      throw new Error('This release supports exactly five rounds per AI game');
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(SCHEMA);
    // Additive migrations keep durable records valid across app upgrades.
    const columns = new Set(
      (
        this.db.prepare('PRAGMA table_info(billing_ai_attempts)').all() as Array<{ name: string }>
      ).map((column) => column.name),
    );
    for (const [column, type] of [
      ['model', 'TEXT'],
      ['prompt_version', 'TEXT'],
      ['status', 'TEXT'],
      ['duration_ms', 'INTEGER'],
      ['error_code', 'TEXT'],
    ]) {
      if (!columns.has(column!))
        this.db.exec(`ALTER TABLE billing_ai_attempts ADD COLUMN ${column} ${type}`);
    }
    const authColumns = this.db
      .prepare('PRAGMA table_info(billing_apple_authorizations)')
      .all() as Array<{ name: string }>;
    if (!authColumns.some((column) => column.name === 'token_hash')) {
      this.db
        .transaction(() => {
          this.db.exec(
            'ALTER TABLE billing_apple_authorizations RENAME TO billing_apple_authorizations_legacy',
          );
          this.db.exec(
            'CREATE TABLE billing_apple_authorizations (account_id TEXT NOT NULL REFERENCES billing_accounts(id), token_hash TEXT NOT NULL, encrypted_refresh_token TEXT NOT NULL, PRIMARY KEY(account_id,token_hash))',
          );
          for (const row of this.db
            .prepare('SELECT * FROM billing_apple_authorizations_legacy')
            .all() as Array<{ account_id: string; encrypted_refresh_token: string }>) {
            this.db
              .prepare('INSERT INTO billing_apple_authorizations VALUES (?,?,?)')
              .run(
                row.account_id,
                digest(row.encrypted_refresh_token),
                row.encrypted_refresh_token,
              );
          }
          this.db.exec('DROP TABLE billing_apple_authorizations_legacy');
        })
        .immediate();
    }
  }
  private account(row: AccountRow): HostAccount {
    return {
      id: row.id,
      appAccountToken: row.account_token,
      credits: row.credits,
      createdAt: row.created_at,
    };
  }
  getAccount(accountId: string): HostAccount | null {
    const row = this.db.prepare('SELECT * FROM billing_accounts WHERE id=?').get(accountId) as
      AccountRow | undefined;
    return row ? this.account(row) : null;
  }
  /** Call only after a trusted identity verifier has authenticated the subject. */
  createHostSession(verifiedSubject: string): {
    token: string;
    expiresAt: number;
    account: HostAccount;
  } {
    if (!verifiedSubject || verifiedSubject.length > 512)
      throw new BillingError('INVALID_IDENTITY', 'Invalid host identity', 401);
    return this.db
      .transaction(() => {
        const now = this.now();
        this.db.prepare('DELETE FROM billing_sessions WHERE expires_at <= ?').run(now);
        const hash = digest(`apple:${verifiedSubject}`);
        let row = this.db
          .prepare('SELECT * FROM billing_accounts WHERE subject_hash=?')
          .get(hash) as AccountRow | undefined;
        if (!row) {
          this.db
            .prepare('INSERT INTO billing_accounts VALUES (?,?,?,?,?)')
            .run(randomUUID(), hash, randomUUID(), this.limits.trialCredits, now);
          row = this.db
            .prepare('SELECT * FROM billing_accounts WHERE subject_hash=?')
            .get(hash) as AccountRow;
        }
        if (this.deletingAccounts.has(row.id))
          throw new BillingError(
            'ACCOUNT_DELETING',
            'Account deletion is in progress. Please try again.',
            409,
          );
        const token = randomBytes(32).toString('base64url');
        const expiresAt = now + this.limits.sessionTtlMs;
        this.db
          .prepare('INSERT INTO billing_sessions VALUES (?,?,?)')
          .run(digest(token), row.id, expiresAt);
        return { token, expiresAt, account: this.account(row) };
      })
      .immediate();
  }
  authorizeSession(token: string): HostAccount | null {
    if (token.length < 32 || token.length > 256) return null;
    const row = this.db
      .prepare(
        `SELECT a.* FROM billing_accounts a JOIN billing_sessions s ON s.account_id=a.id
      WHERE s.token_hash=? AND s.expires_at>?`,
      )
      .get(digest(token), this.now()) as AccountRow | undefined;
    return row ? this.account(row) : null;
  }
  revokeSession(token: string): void {
    this.db.prepare('DELETE FROM billing_sessions WHERE token_hash=?').run(digest(token));
  }
  beginAccountDeletion(accountId: string): void {
    if (this.deletingAccounts.has(accountId))
      throw new BillingError('ACCOUNT_DELETING', 'Account deletion is already in progress.', 409);
    this.deletingAccounts.add(accountId);
  }
  endAccountDeletion(accountId: string): void {
    this.deletingAccounts.delete(accountId);
  }
  saveAppleAuthorization(
    accountId: string,
    encryptedRefreshToken: string,
    tokenHash: string,
  ): void {
    this.db
      .prepare(
        'INSERT INTO billing_apple_authorizations VALUES (?,?,?) ON CONFLICT(account_id,token_hash) DO UPDATE SET encrypted_refresh_token=excluded.encrypted_refresh_token',
      )
      .run(accountId, tokenHash, encryptedRefreshToken);
  }
  getAppleAuthorizations(accountId: string): string[] {
    return (
      this.db
        .prepare(
          'SELECT encrypted_refresh_token FROM billing_apple_authorizations WHERE account_id=?',
        )
        .all(accountId) as Array<{ encrypted_refresh_token: string }>
    ).map((row) => row.encrypted_refresh_token);
  }
  /** Remove usable identity/session state while retaining hashed anti-replay financial records. */
  deleteAccount(accountId: string): void {
    this.db
      .transaction(() => {
        this.db.prepare('DELETE FROM billing_sessions WHERE account_id=?').run(accountId);
        this.db
          .prepare('DELETE FROM billing_apple_authorizations WHERE account_id=?')
          .run(accountId);
        this.db
          .prepare(
            "UPDATE billing_games SET status='completed',refund_reason='account_deleted' WHERE account_id=? AND status='active'",
          )
          .run(accountId);
        // No name, email, Apple token, or raw subject is stored. Keep the one-way
        // subject tombstone to prevent delete/recreate from farming free credits.
        this.db
          .prepare('UPDATE billing_accounts SET credits=MIN(credits,0), account_token=? WHERE id=?')
          .run(randomUUID(), accountId);
      })
      .immediate();
  }
  createChallenge(): { challengeId: string; nonce: string; expiresAt: number } {
    return this.db
      .transaction(() => {
        const now = this.now();
        this.db.prepare('DELETE FROM billing_challenges WHERE expires_at <= ?').run(now);
        const count = (
          this.db.prepare('SELECT COUNT(*) AS n FROM billing_challenges').get() as { n: number }
        ).n;
        if (count >= 10_000)
          throw new BillingError('BUSY', 'Please try signing in again shortly.', 429);
        const challengeId = randomUUID(),
          nonce = randomBytes(32).toString('base64url'),
          expiresAt = now + 5 * 60_000;
        this.db
          .prepare('INSERT INTO billing_challenges VALUES (?,?,?)')
          .run(challengeId, digest(nonce), expiresAt);
        return { challengeId, nonce, expiresAt };
      })
      .immediate();
  }
  /** Atomically consumes the challenge with the nonce recovered from the verified Apple JWT. */
  consumeChallenge(challengeId: string, verifiedNonce: string): void {
    const result = this.db
      .prepare('DELETE FROM billing_challenges WHERE id=? AND nonce_hash=? AND expires_at>?')
      .run(challengeId, digest(verifiedNonce), this.now());
    if (result.changes !== 1)
      throw new BillingError(
        'INVALID_CHALLENGE',
        'Sign-in expired or was already used. Please sign in again.',
        401,
      );
  }
  getGame(roomCode: string): GameReservation | null {
    const row = this.db.prepare('SELECT * FROM billing_games WHERE room_code=?').get(roomCode) as
      GameRow | undefined;
    return row
      ? {
          roomCode: row.room_code,
          accountId: row.account_id,
          status: row.status,
          maxRounds: row.max_rounds,
          createdAt: row.created_at,
          expiresAt: row.expires_at,
        }
      : null;
  }
  reserveGame(accountId: string, roomCode: string): GameReservation {
    if (!roomCode || roomCode.length > 128) throw new BillingError('INVALID_GAME', 'Invalid game');
    return this.db
      .transaction(() => {
        if (this.deletingAccounts.has(accountId))
          throw new BillingError('ACCOUNT_DELETING', 'Account deletion is in progress.', 409);
        const previous = this.getGame(roomCode);
        if (previous) {
          if (previous.accountId !== accountId)
            throw new BillingError('GAME_OWNERSHIP', 'This game belongs to another host');
          if (previous.status !== 'active' || previous.expiresAt <= this.now())
            throw new BillingError('GAME_CLOSED', 'Start a new room for another AI game', 409);
          return previous;
        }
        const now = this.now(),
          dayStart = Date.parse(new Date(now).toISOString().slice(0, 10));
        const active = this.db
          .prepare(
            "SELECT room_code FROM billing_games WHERE account_id=? AND status='active' AND expires_at>? LIMIT 1",
          )
          .get(accountId, now);
        if (active)
          throw new BillingError('ACTIVE_GAME', 'Finish your current AI game first.', 409);
        const games = (
          this.db
            .prepare('SELECT COUNT(*) AS n FROM billing_games WHERE account_id=? AND created_at>=?')
            .get(accountId, dayStart) as { n: number }
        ).n;
        if (games >= this.limits.hostDailyGames)
          throw new BillingError(
            'DAILY_GAME_LIMIT',
            'You have reached today’s AI game limit.',
            429,
          );
        const charge = this.db
          .prepare('UPDATE billing_accounts SET credits=credits-1 WHERE id=? AND credits>0')
          .run(accountId);
        if (!charge.changes)
          throw new BillingError('NO_GAME_CREDITS', 'Add a game pack to use the AI judge.', 402);
        this.db
          .prepare(
            'INSERT INTO billing_games (room_code,account_id,status,max_rounds,created_at,expires_at) VALUES (?,?,?,?,?,?)',
          )
          .run(
            roomCode,
            accountId,
            'active',
            this.limits.maxRoundsPerGame,
            now,
            now + 6 * 3_600_000,
          );
        return this.getGame(roomCode)!;
      })
      .immediate();
  }
  /**
   * Free AI game for a public, non-commercial deployment. No credit is spent;
   * cost stays bounded by a site-wide daily game cap plus the same durable
   * per-attempt reservations and daily/monthly budgets as paid games.
   */
  reserveOpenGame(roomCode: string, dailyGames: number): GameReservation {
    if (!roomCode || roomCode.length > 128) throw new BillingError('INVALID_GAME', 'Invalid game');
    integer(dailyGames, 'open AI daily games', 0);
    return this.db
      .transaction(() => {
        const previous = this.getGame(roomCode);
        if (previous) {
          if (previous.accountId !== OPEN_AI_ACCOUNT_ID)
            throw new BillingError('GAME_OWNERSHIP', 'This game belongs to another host');
          return previous;
        }
        const now = this.now(),
          dayStart = Date.parse(new Date(now).toISOString().slice(0, 10));
        this.db
          .prepare(
            'INSERT OR IGNORE INTO billing_accounts (id,subject_hash,account_token,credits,created_at) VALUES (?,?,?,0,?)',
          )
          .run(OPEN_AI_ACCOUNT_ID, OPEN_AI_ACCOUNT_ID, randomUUID(), now);
        const games = (
          this.db
            .prepare('SELECT COUNT(*) AS n FROM billing_games WHERE account_id=? AND created_at>=?')
            .get(OPEN_AI_ACCOUNT_ID, dayStart) as { n: number }
        ).n;
        if (games >= dailyGames)
          throw new BillingError('DAILY_GAME_LIMIT', 'Today’s free AI games are used up.', 429);
        this.db
          .prepare(
            'INSERT INTO billing_games (room_code,account_id,status,max_rounds,created_at,expires_at) VALUES (?,?,?,?,?,?)',
          )
          .run(
            roomCode,
            OPEN_AI_ACCOUNT_ID,
            'active',
            this.limits.maxRoundsPerGame,
            now,
            now + 6 * 3_600_000,
          );
        return this.getGame(roomCode)!;
      })
      .immediate();
  }
  canContinueGame(roomCode: string, roundIdx: number): boolean {
    const game = this.getGame(roomCode);
    return (
      !!game &&
      game.status === 'active' &&
      game.expiresAt > this.now() &&
      Number.isInteger(roundIdx) &&
      roundIdx >= 1 &&
      roundIdx <= game.maxRounds
    );
  }
  completeGame(roomCode: string): void {
    this.db
      .prepare("UPDATE billing_games SET status='completed' WHERE room_code=? AND status='active'")
      .run(roomCode);
  }
  refundGame(roomCode: string, reason: string): boolean {
    return this.db
      .transaction(() => {
        const game = this.getGame(roomCode);
        if (!game || game.status === 'refunded') return false;
        if (
          this.db
            .prepare(
              "SELECT 1 FROM billing_games WHERE room_code=? AND refund_reason='account_deleted'",
            )
            .get(roomCode)
        )
          return false;
        this.db
          .prepare("UPDATE billing_games SET status='refunded', refund_reason=? WHERE room_code=?")
          .run(reason.slice(0, 200), roomCode);
        this.db
          .prepare('UPDATE billing_accounts SET credits=credits+1 WHERE id=?')
          .run(game.accountId);
        return true;
      })
      .immediate();
  }
  grantPurchase(input: {
    transactionId: string;
    accountId: string;
    productId: string;
    credits: number;
  }): boolean {
    integer(input.credits, 'purchase credits', 1);
    return this.db
      .transaction(() => {
        if (this.deletingAccounts.has(input.accountId))
          throw new BillingError('ACCOUNT_DELETING', 'Account deletion is in progress.', 409);
        const existing = this.db
          .prepare('SELECT account_id FROM billing_purchases WHERE transaction_id=?')
          .get(input.transactionId) as { account_id: string } | undefined;
        if (existing) {
          if (existing.account_id !== input.accountId)
            throw new BillingError('PURCHASE_OWNERSHIP', 'Purchase belongs to another host');
          return false;
        }
        // Refund-before-delivery cannot resurrect a revoked transaction.
        if (
          this.db
            .prepare('SELECT 1 FROM billing_revocations WHERE transaction_id=?')
            .get(input.transactionId)
        )
          throw new BillingError('PURCHASE_REVOKED', 'This purchase was refunded');
        this.db
          .prepare('INSERT INTO billing_purchases VALUES (?,?,?,?,0,?)')
          .run(input.transactionId, input.accountId, input.productId, input.credits, this.now());
        this.db
          .prepare('UPDATE billing_accounts SET credits=credits+? WHERE id=?')
          .run(input.credits, input.accountId);
        return true;
      })
      .immediate();
  }
  revokePurchase(transactionId: string, notificationId: string): boolean {
    return this.db
      .transaction(() => {
        if (
          !this.db
            .prepare('INSERT OR IGNORE INTO billing_notifications VALUES (?,?)')
            .run(notificationId, this.now()).changes
        )
          return false;
        this.db
          .prepare('INSERT OR IGNORE INTO billing_revocations VALUES (?,?)')
          .run(transactionId, this.now());
        const purchase = this.db
          .prepare(
            'SELECT account_id,credits,revoked FROM billing_purchases WHERE transaction_id=?',
          )
          .get(transactionId) as
          { account_id: string; credits: number; revoked: number } | undefined;
        if (!purchase || purchase.revoked) return false;
        this.db
          .prepare('UPDATE billing_purchases SET revoked=1 WHERE transaction_id=?')
          .run(transactionId);
        // Keep debt if purchased games have already been spent; future purchases repay it.
        this.db
          .prepare('UPDATE billing_accounts SET credits=credits-? WHERE id=?')
          .run(purchase.credits, purchase.account_id);
        return true;
      })
      .immediate();
  }
  reserveAiAttempt(input: { id: string; roomCode: string; maxCostMicros: number }): boolean {
    integer(input.maxCostMicros, 'AI request reservation', 1);
    return this.db
      .transaction(() => {
        const existing = this.db
          .prepare('SELECT room_code,reserved_micros FROM billing_ai_attempts WHERE id=?')
          .get(input.id) as { room_code: string; reserved_micros: number } | undefined;
        if (existing) {
          if (
            existing.room_code !== input.roomCode ||
            existing.reserved_micros !== input.maxCostMicros
          )
            throw new BillingError('ATTEMPT_CONFLICT', 'AI request was already reserved', 409);
          return false;
        }
        const game = this.getGame(input.roomCode);
        if (!game || game.status !== 'active' || game.expiresAt <= this.now())
          throw new BillingError('GAME_NOT_AUTHORIZED', 'AI game allowance is unavailable');
        const iso = new Date(this.now()).toISOString(),
          day = iso.slice(0, 10),
          month = iso.slice(0, 7);
        const spent = (column: 'day' | 'month', key: string): number =>
          (
            this.db
              .prepare(
                `SELECT COALESCE(SUM(charged_micros),0) AS total FROM billing_ai_attempts WHERE ${column}=?`,
              )
              .get(key) as { total: number }
          ).total;
        if (
          spent('day', day) + input.maxCostMicros > this.limits.dailyBudgetMicros ||
          spent('month', month) + input.maxCostMicros > this.limits.monthlyBudgetMicros
        )
          throw new BillingError(
            'AI_BUDGET_EXHAUSTED',
            'The AI judge has reached its allowance. Your game credit will be restored.',
            503,
          );
        this.db
          .prepare(
            'INSERT INTO billing_ai_attempts (id,room_code,reserved_micros,charged_micros,day,month,created_at) VALUES (?,?,?,?,?,?,?)',
          )
          .run(
            input.id,
            input.roomCode,
            input.maxCostMicros,
            input.maxCostMicros,
            day,
            month,
            this.now(),
          );
        return true;
      })
      .immediate();
  }
  settleAiAttempt(id: string, usage: AiAttemptUsage): void {
    if (usage.costMicros !== undefined) integer(usage.costMicros, 'AI cost');
    if (usage.inputTokens !== undefined) integer(usage.inputTokens, 'input tokens');
    if (usage.outputTokens !== undefined) integer(usage.outputTokens, 'output tokens');
    if (usage.durationMs !== undefined) integer(usage.durationMs, 'AI request duration');
    // Missing/uncertain provider usage retains the maximum, including after a crash.
    this.db
      .prepare(
        'UPDATE billing_ai_attempts SET settled=1,charged_micros=COALESCE(?,reserved_micros),input_tokens=?,output_tokens=?,model=?,prompt_version=?,status=?,duration_ms=?,error_code=? WHERE id=? AND settled=0',
      )
      .run(
        usage.costMicros ?? null,
        usage.inputTokens ?? null,
        usage.outputTokens ?? null,
        usage.model?.slice(0, 200) ?? null,
        usage.promptVersion?.slice(0, 100) ?? null,
        usage.status ?? null,
        usage.durationMs ?? null,
        usage.errorCode?.slice(0, 100) ?? null,
        id,
      );
  }
  getMetrics(): BillingMetrics {
    const totals = this.db
      .prepare(
        `SELECT COUNT(*) AS attempts,
      COALESCE(SUM(CASE WHEN status='success' THEN 1 ELSE 0 END),0) AS successes,
      COALESCE(SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END),0) AS failures,
      COALESCE(SUM(CASE WHEN settled=0 THEN 1 ELSE 0 END),0) AS pending,
      COALESCE(SUM(charged_micros),0) AS totalCostMicros, AVG(duration_ms) AS meanDurationMs
      FROM billing_ai_attempts`,
      )
      .get() as Omit<BillingMetrics, 'models'>;
    const models = this.db
      .prepare(
        `SELECT model,prompt_version AS promptVersion,COUNT(*) AS attempts,
      COALESCE(SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END),0) AS failures,AVG(duration_ms) AS meanDurationMs
      FROM billing_ai_attempts GROUP BY model,prompt_version ORDER BY attempts DESC LIMIT 100`,
      )
      .all() as BillingMetrics['models'];
    return { ...totals, models };
  }
  getBudget(): { dailySpentMicros: number; monthlySpentMicros: number; pendingAttempts: number } {
    const iso = new Date(this.now()).toISOString();
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN day=? THEN charged_micros ELSE 0 END),0) AS daily,
      COALESCE(SUM(CASE WHEN month=? THEN charged_micros ELSE 0 END),0) AS monthly,
      COALESCE(SUM(CASE WHEN settled=0 THEN 1 ELSE 0 END),0) AS pending FROM billing_ai_attempts`,
      )
      .get(iso.slice(0, 10), iso.slice(0, 7)) as {
      daily: number;
      monthly: number;
      pending: number;
    };
    return {
      dailySpentMicros: row.daily,
      monthlySpentMicros: row.monthly,
      pendingAttempts: row.pending,
    };
  }
  close(): void {
    this.db.close();
  }
}
