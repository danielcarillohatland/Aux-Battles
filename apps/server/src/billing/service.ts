import { createHash } from 'node:crypto';
import {
  AppleAuthorization,
  encryptRefreshToken,
  decryptRefreshToken,
  type AppleAuthorizationClient,
} from './apple-authorization.js';
import {
  AppleSignInVerifier,
  appleBillingConfig,
  createAppleTransactionVerifier,
  validateGameTransaction,
  type AppleBillingConfig,
  type AppleIdentityVerifier,
  type AppleTransactionVerifier,
} from './apple.js';
import {
  BillingError,
  SqliteBillingLedger,
  type HostAccount,
  type BillingLedgerOptions,
} from './ledger.js';

export interface BillingServiceOptions {
  ledger: SqliteBillingLedger;
  config: AppleBillingConfig | null;
  identityVerifier?: AppleIdentityVerifier;
  transactionVerifier?: AppleTransactionVerifier | null;
  authorizationClient?: AppleAuthorizationClient;
}
/** Verified identity and StoreKit boundary. No caller-supplied subject, price or credits are trusted. */
export class BillingService {
  readonly ledger: SqliteBillingLedger;
  readonly config: AppleBillingConfig | null;
  private readonly identityVerifier: AppleIdentityVerifier | null;
  private readonly transactionVerifier: AppleTransactionVerifier | null;
  private readonly authorizationClient: AppleAuthorizationClient | null;
  constructor(options: BillingServiceOptions) {
    this.ledger = options.ledger;
    this.config = options.config;
    this.identityVerifier =
      options.identityVerifier ??
      (options.config ? new AppleSignInVerifier(options.config.signInAudience) : null);
    this.authorizationClient =
      options.authorizationClient ??
      (options.config?.authorization ? new AppleAuthorization(options.config.authorization) : null);
    this.transactionVerifier =
      options.transactionVerifier === undefined
        ? options.config
          ? createAppleTransactionVerifier(options.config)
          : null
        : options.transactionVerifier;
  }
  publicConfig() {
    return {
      signInAvailable:
        this.identityVerifier !== null &&
        (!this.config?.requireAuthorization || this.authorizationClient !== null),
      purchasesAvailable:
        this.transactionVerifier !== null &&
        !!this.config &&
        Object.keys(this.config.products).length > 0,
      signInAudience: this.config?.signInAudience ?? null,
      nativeOnly: true,
      products: Object.entries(this.config?.products ?? {}).map(([productId, credits]) => ({
        productId,
        credits,
      })),
      maxRoundsPerGame: this.ledger.limits.maxRoundsPerGame,
      hostDailyGames: this.ledger.limits.hostDailyGames,
      trialCredits: this.ledger.limits.trialCredits,
    };
  }
  challenge() {
    if (!this.identityVerifier || (this.config?.requireAuthorization && !this.authorizationClient))
      throw new BillingError('SIGN_IN_UNAVAILABLE', 'Apple sign-in is not configured yet.', 503);
    return this.ledger.createChallenge();
  }
  async signIn(identityToken: string, challengeId: string, authorizationCode?: string) {
    if (!this.identityVerifier || (this.config?.requireAuthorization && !this.authorizationClient))
      throw new BillingError('SIGN_IN_UNAVAILABLE', 'Apple sign-in is not configured yet.', 503);
    const identity = await this.identityVerifier.verify(identityToken);
    if (this.authorizationClient && (!authorizationCode || authorizationCode.length > 4096))
      throw new BillingError(
        'APPLE_AUTHORIZATION_REQUIRED',
        'Please complete Apple sign-in again.',
        401,
      );
    this.ledger.consumeChallenge(challengeId, identity.nonce);
    let refreshToken: string | undefined;
    if (this.authorizationClient) {
      const grant = await this.authorizationClient.exchange(authorizationCode!);
      const exchanged = await this.identityVerifier.verify(grant.identityToken);
      if (exchanged.subject !== identity.subject || exchanged.nonce !== identity.nonce)
        throw new BillingError(
          'INVALID_APPLE_AUTHORIZATION',
          'Apple authorization did not match this sign-in.',
          401,
        );
      refreshToken = grant.refreshToken;
    }
    let session;
    try {
      session = this.ledger.createHostSession(identity.subject);
    } catch (error) {
      // A concurrent deletion must not leave a newly issued grant untracked.
      if (refreshToken && this.authorizationClient)
        await this.authorizationClient.revoke(refreshToken);
      throw error;
    }
    if (refreshToken) {
      if (!this.config?.authorization)
        throw new Error('Apple refresh token encryption is not configured');
      this.ledger.saveAppleAuthorization(
        session.account.id,
        encryptRefreshToken(
          refreshToken,
          session.account.id,
          this.config.authorization.encryptionKey,
        ),
        createHash('sha256').update(refreshToken).digest('hex'),
      );
    }
    return session;
  }
  async deleteAccount(account: HostAccount): Promise<void> {
    this.ledger.beginAccountDeletion(account.id);
    try {
      const authorizations = this.ledger.getAppleAuthorizations(account.id);
      if (authorizations.length) {
        if (!this.authorizationClient || !this.config?.authorization)
          throw new BillingError(
            'APPLE_AUTHORIZATION_UNAVAILABLE',
            'Account deletion is temporarily unavailable. Please try again.',
            503,
          );
        for (const encrypted of authorizations) {
          const refreshToken = decryptRefreshToken(
            encrypted,
            account.id,
            this.config.authorization.encryptionKey,
          );
          await this.authorizationClient.revoke(refreshToken);
        }
      } else if (this.config?.requireAuthorization) {
        throw new BillingError(
          'APPLE_AUTHORIZATION_REQUIRED',
          'Sign in with Apple again before deleting your account.',
          401,
        );
      }
      this.ledger.deleteAccount(account.id);
    } finally {
      this.ledger.endAccountDeletion(account.id);
    }
  }
  requireAccount(token: string): HostAccount {
    const account = this.ledger.authorizeSession(token);
    if (!account)
      throw new BillingError('HOST_SIGN_IN_REQUIRED', 'Sign in to use your AI game credits.', 401);
    return account;
  }
  async purchase(account: HostAccount, signedTransaction: string) {
    if (!this.config || !this.transactionVerifier)
      throw new BillingError('PURCHASES_UNAVAILABLE', 'Game packs are not available yet.', 503);
    let decoded;
    try {
      decoded = await this.transactionVerifier.verifyAndDecodeTransaction(signedTransaction);
    } catch {
      throw new BillingError(
        'INVALID_PURCHASE',
        'Apple could not verify this purchase. No credits were changed.',
        400,
      );
    }
    const tx = validateGameTransaction(decoded, this.config);
    const currentAccount = this.ledger.getAccount(account.id);
    if (!currentAccount || tx.accountToken !== currentAccount.appAccountToken.toLowerCase())
      throw new BillingError('PURCHASE_OWNERSHIP', 'Purchase belongs to another host');
    const granted = this.ledger.grantPurchase({
      transactionId: tx.transactionId,
      productId: tx.productId,
      credits: tx.credits,
      accountId: account.id,
    });
    return { granted, account: this.ledger.getAccount(account.id)! };
  }
  async notification(signedPayload: string): Promise<{ handled: boolean }> {
    if (!this.transactionVerifier || !this.config)
      throw new BillingError(
        'PURCHASES_UNAVAILABLE',
        'Apple notifications are not configured.',
        503,
      );
    let notification;
    try {
      notification = await this.transactionVerifier.verifyAndDecodeNotification(signedPayload);
    } catch {
      throw new BillingError('INVALID_NOTIFICATION', 'Invalid Apple notification', 400);
    }
    if (!notification.notificationUUID)
      throw new BillingError('INVALID_NOTIFICATION', 'Missing Apple notification identity', 400);
    if (notification.notificationType !== 'REFUND' && notification.notificationType !== 'REVOKE')
      return { handled: false };
    const signedTransaction = notification.data?.signedTransactionInfo;
    if (!signedTransaction)
      throw new BillingError('INVALID_NOTIFICATION', 'Missing signed transaction', 400);
    let tx;
    try {
      tx = await this.transactionVerifier.verifyAndDecodeTransaction(signedTransaction);
    } catch {
      throw new BillingError('INVALID_NOTIFICATION', 'Invalid signed transaction', 400);
    }
    if (
      tx.bundleId !== this.config.bundleId ||
      tx.environment !== this.config.environment ||
      !tx.transactionId ||
      !tx.productId ||
      !Object.hasOwn(this.config.products, tx.productId) ||
      tx.revocationDate === undefined
    )
      throw new BillingError('INVALID_NOTIFICATION', 'Invalid revoked purchase', 400);
    return { handled: this.ledger.revokePurchase(tx.transactionId, notification.notificationUUID) };
  }
}
function numberFromEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  if (env[key] === undefined) return fallback;
  const n = Number(env[key]);
  if (!env[key]?.trim() || !Number.isSafeInteger(n) || n < 0)
    throw new Error(`${key} must be a nonnegative integer`);
  return n;
}
export function billingLedgerOptionsFromEnv(
  env: NodeJS.ProcessEnv,
  aiAccess: 'open' | 'account' = 'account',
): BillingLedgerOptions {
  // A free public site spends the operator's own money: default to small caps.
  const open = aiAccess === 'open';
  return {
    dailyBudgetMicros: numberFromEnv(env, 'AUX_AI_DAILY_BUDGET_MICROS', open ? 500_000 : 5_000_000),
    monthlyBudgetMicros: numberFromEnv(
      env,
      'AUX_AI_MONTHLY_BUDGET_MICROS',
      open ? 3_000_000 : 50_000_000,
    ),
    maxRoundsPerGame: numberFromEnv(env, 'AUX_GAME_MAX_ROUNDS', 5),
    hostDailyGames: numberFromEnv(env, 'AUX_HOST_DAILY_GAMES', 10),
    trialCredits: numberFromEnv(env, 'AUX_TRIAL_GAME_CREDITS', 1),
  };
}
export function createBillingService(
  env: NodeJS.ProcessEnv,
  ledger: SqliteBillingLedger,
): BillingService {
  return new BillingService({ ledger, config: appleBillingConfig(env) });
}
