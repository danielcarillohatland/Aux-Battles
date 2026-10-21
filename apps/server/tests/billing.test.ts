import {
  AppleAuthorization,
  encryptRefreshToken,
  decryptRefreshToken,
} from '../src/billing/apple-authorization.js';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify from 'fastify';
import { createLocalJWKSet, exportJWK, exportPKCS8, generateKeyPair, SignJWT } from 'jose';
import { Environment, SignedDataVerifier, Type } from '@apple/app-store-server-library';
import { BillingError, SqliteBillingLedger } from '../src/billing/ledger.js';
import {
  AppleSignInVerifier,
  appleBillingConfig,
  type AppleBillingConfig,
  type AppleTransactionVerifier,
} from '../src/billing/apple.js';
import { BillingService } from '../src/billing/service.js';
import { billingRoute } from '../src/routes/billing.js';

const open: SqliteBillingLedger[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const db of open.splice(0)) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const ledger = (
  opts: ConstructorParameters<typeof SqliteBillingLedger>[1] = {},
  file = ':memory:',
) => {
  const db = new SqliteBillingLedger(file, opts);
  open.push(db);
  return db;
};
const config: AppleBillingConfig = {
  bundleId: 'com.test.aux',
  signInAudience: 'com.test.aux',
  environment: Environment.SANDBOX,
  products: { 'com.test.aux.five': 5 },
  rootCertificateFiles: [],
};
function transaction(accountToken: string) {
  return {
    transactionId: 'tx-1',
    productId: 'com.test.aux.five',
    appAccountToken: accountToken,
    bundleId: config.bundleId,
    environment: config.environment,
    type: Type.CONSUMABLE,
    quantity: 1,
    inAppOwnershipType: 'PURCHASED',
    purchaseDate: Date.now() - 1000,
  };
}

describe('persistent host credits and spending', () => {
  it('grants one trial per verified subject and never stores a bearer token or raw subject', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aux-billing-'));
    dirs.push(dir);
    const file = join(dir, 'billing.sqlite');
    const db = ledger({}, file),
      first = db.createHostSession('apple-private-subject'),
      second = db.createHostSession('apple-private-subject');
    expect(first.account.id).toBe(second.account.id);
    expect(second.account.credits).toBe(1);
    expect(db.authorizeSession('invented-install-id')).toBeNull();
    db.close();
    const raw = readFileSync(file).toString();
    expect(raw).not.toContain(first.token);
    expect(raw).not.toContain('apple-private-subject');
    const restart = ledger({}, file);
    expect(restart.authorizeSession(first.token)?.id).toBe(first.account.id);
  });
  it('charges a game once, forbids concurrent rooms and refunds exactly once', () => {
    const db = ledger({ trialCredits: 3 });
    const { account } = db.createHostSession('host');
    db.reserveGame(account.id, 'room');
    db.reserveGame(account.id, 'room');
    expect(db.getAccount(account.id)?.credits).toBe(2);
    expect(() => db.reserveGame(account.id, 'other')).toThrow('Finish your current');
    expect(db.refundGame('room', 'outage')).toBe(true);
    expect(db.refundGame('room', 'repeat')).toBe(false);
    expect(db.getAccount(account.id)?.credits).toBe(3);
    expect(db.canContinueGame('room', 1)).toBe(false);
    expect(() => db.reserveGame(account.id, 'room')).toThrow('Start a new room');
  });
  it('protects room ownership, game expiry, round cap, daily quota and session expiry', () => {
    let now = Date.UTC(2026, 8, 1);
    const db = ledger({ now: () => now, trialCredits: 5, hostDailyGames: 1, sessionTtlMs: 1000 });
    const host = db.createHostSession('h'),
      other = db.createHostSession('o');
    db.reserveGame(host.account.id, 'r');
    expect(db.canContinueGame('r', 5)).toBe(true);
    expect(db.canContinueGame('r', 0)).toBe(false);
    expect(db.canContinueGame('r', 6)).toBe(false);
    expect(() => db.reserveGame(other.account.id, 'r')).toThrow('another host');
    now += 1001;
    expect(db.authorizeSession(host.token)).toBeNull();
    now += 6 * 3_600_000;
    expect(db.canContinueGame('r', 1)).toBe(false);
    expect(() => db.reserveGame(host.account.id, 'r2')).toThrow('today');
  });
  it('holds uncertain costs across process restart and enforces budgets atomically across connections', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aux-budgets-'));
    dirs.push(dir);
    const file = join(dir, 'billing.sqlite');
    const options = { dailyBudgetMicros: 100, monthlyBudgetMicros: 100, trialCredits: 2 };
    const first = ledger(options, file),
      { account } = first.createHostSession('h');
    first.reserveGame(account.id, 'r');
    expect(first.reserveAiAttempt({ id: 'one', roomCode: 'r', maxCostMicros: 60 })).toBe(true);
    first.close();
    const second = ledger(options, file),
      parallel = ledger(options, file);
    expect(second.reserveAiAttempt({ id: 'one', roomCode: 'r', maxCostMicros: 60 })).toBe(false);
    expect(() =>
      parallel.reserveAiAttempt({ id: 'two', roomCode: 'r', maxCostMicros: 60 }),
    ).toThrow('allowance');
    second.settleAiAttempt('one', { costMicros: 20, inputTokens: 10, outputTokens: 5 });
    expect(parallel.reserveAiAttempt({ id: 'two', roomCode: 'r', maxCostMicros: 60 })).toBe(true);
    parallel.settleAiAttempt('two', {});
    second.settleAiAttempt('two', { costMicros: 0 });
    expect(second.getBudget()).toEqual({
      dailySpentMicros: 80,
      monthlySpentMicros: 80,
      pendingAttempts: 0,
    });
  });
  it('keeps monthly spend across UTC day rollover, while daily resets', () => {
    let now = Date.UTC(2026, 8, 1, 23, 59);
    const db = ledger({ now: () => now, dailyBudgetMicros: 100, monthlyBudgetMicros: 120 });
    const { account } = db.createHostSession('h');
    db.reserveGame(account.id, 'r');
    db.reserveAiAttempt({ id: 'a', roomCode: 'r', maxCostMicros: 80 });
    now += 120_000;
    expect(db.getBudget().dailySpentMicros).toBe(0);
    expect(() => db.reserveAiAttempt({ id: 'b', roomCode: 'r', maxCostMicros: 50 })).toThrow(
      'allowance',
    );
  });
  it('revokes a purchase once, tracks spent-credit debt and blocks refund-before-purchase replay', () => {
    const db = ledger({ trialCredits: 0 });
    const { account } = db.createHostSession('h');
    const p = { transactionId: 't', accountId: account.id, productId: 'p', credits: 1 };
    expect(db.grantPurchase(p)).toBe(true);
    expect(db.grantPurchase(p)).toBe(false);
    db.reserveGame(account.id, 'r');
    expect(db.revokePurchase('t', 'n')).toBe(true);
    expect(db.revokePurchase('t', 'n')).toBe(false);
    expect(db.revokePurchase('t', 'n2')).toBe(false);
    expect(db.getAccount(account.id)?.credits).toBe(-1);
    db.completeGame('r');
    expect(() => db.reserveGame(account.id, 'next')).toThrow('Add a game');
    db.revokePurchase('future', 'early');
    expect(() => db.grantPurchase({ ...p, transactionId: 'future' })).toThrow('refunded');
  });
  it('deletion invalidates all sessions and credits without regranting a trial', () => {
    const db = ledger();
    const a = db.createHostSession('h'),
      b = db.createHostSession('h');
    db.deleteAccount(a.account.id);
    expect(db.authorizeSession(a.token)).toBeNull();
    expect(db.authorizeSession(b.token)).toBeNull();
    const again = db.createHostSession('h');
    expect(again.account.credits).toBe(0);
    expect(again.account.appAccountToken).not.toBe(a.account.appAccountToken);
  });
  it('fails closed when the database cannot be read', () => {
    const db = ledger();
    db.close();
    expect(() => db.reserveGame('any', 'r')).toThrow();
  });
});

describe('Apple proof validation and billing HTTP', () => {
  it('checks signatures, issuer, audience, expiry, nonce and one-time challenge consumption', async () => {
    const keys = await generateKeyPair('RS256');
    const jwk = await exportJWK(keys.publicKey);
    jwk.kid = 'test';
    const verifier = new AppleSignInVerifier(
      config.signInAudience,
      createLocalJWKSet({ keys: [jwk] }),
    );
    const db = ledger(),
      service = new BillingService({
        ledger: db,
        config,
        identityVerifier: verifier,
        transactionVerifier: null,
      });
    const challenge = service.challenge();
    const sign = (overrides: Record<string, unknown> = {}) =>
      new SignJWT({ nonce: challenge.nonce, ...overrides })
        .setProtectedHeader({ alg: 'RS256', kid: 'test' })
        .setIssuer('https://appleid.apple.com')
        .setSubject('user')
        .setAudience(config.signInAudience)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(keys.privateKey);
    const good = await sign();
    const session = await service.signIn(good, challenge.challengeId);
    expect(session.account.credits).toBe(1);
    await expect(service.signIn(good, challenge.challengeId)).rejects.toThrow('already used');
    await expect(
      service.signIn(await sign({ nonce: 'other' }), service.challenge().challengeId),
    ).rejects.toThrow('Sign-in expired');
    const invalid = `${good.slice(0, good.lastIndexOf('.') + 1)}invalid`;
    await expect(verifier.verify(invalid)).rejects.toThrow('could not be verified');
    const wrongAudience = await new SignJWT({ nonce: 'n' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test' })
      .setIssuer('https://appleid.apple.com')
      .setSubject('user')
      .setAudience('wrong-app')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(keys.privateKey);
    await expect(verifier.verify(wrongAudience)).rejects.toThrow('could not be verified');
    const expired = await new SignJWT({ nonce: 'n' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test' })
      .setIssuer('https://appleid.apple.com')
      .setSubject('user')
      .setAudience(config.signInAudience)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(keys.privateKey);
    await expect(verifier.verify(expired)).rejects.toThrow('could not be verified');
  });
  it('rejects forged StoreKit data through the official verifier', async () => {
    const db = ledger(),
      { account } = db.createHostSession('h');
    const service = new BillingService({
      ledger: db,
      config,
      transactionVerifier: new SignedDataVerifier([], true, Environment.SANDBOX, config.bundleId),
    });
    await expect(service.purchase(account, 'eyJhbGciOiJub25lIn0.e30.')).rejects.toThrow(
      'could not verify',
    );
    expect(db.getAccount(account.id)?.credits).toBe(1);
  });
  it('checks purchase ownership, product, environment and revocation, then deduplicates delivery', async () => {
    const db = ledger(),
      { account } = db.createHostSession('h');
    let tx = transaction(account.appAccountToken);
    const verifier: AppleTransactionVerifier = {
      verifyAndDecodeTransaction: async () => tx,
      verifyAndDecodeNotification: async () => ({}),
    };
    const service = new BillingService({ ledger: db, config, transactionVerifier: verifier });
    tx = { ...tx, appAccountToken: 'someone-else' };
    await expect(service.purchase(account, 'signed')).rejects.toThrow('another host');
    tx = { ...transaction(account.appAccountToken), productId: 'unknown' };
    await expect(service.purchase(account, 'signed')).rejects.toThrow('supported game pack');
    tx = { ...transaction(account.appAccountToken), environment: Environment.PRODUCTION };
    await expect(service.purchase(account, 'signed')).rejects.toThrow('supported game pack');
    tx = transaction(account.appAccountToken);
    expect((await service.purchase(account, 'signed')).granted).toBe(true);
    expect((await service.purchase(account, 'signed')).granted).toBe(false);
    expect(db.getAccount(account.id)?.credits).toBe(6);
  });
  it('handles signed refund notifications idempotently', async () => {
    const db = ledger(),
      { account } = db.createHostSession('h');
    const tx = transaction(account.appAccountToken);
    db.grantPurchase({
      transactionId: tx.transactionId,
      accountId: account.id,
      productId: tx.productId,
      credits: 5,
    });
    const verifier: AppleTransactionVerifier = {
      verifyAndDecodeTransaction: async () => ({ ...tx, revocationDate: Date.now() }),
      verifyAndDecodeNotification: async () => ({
        notificationUUID: 'n',
        notificationType: 'REFUND',
        data: { signedTransactionInfo: 'signed' },
      }),
    };
    const service = new BillingService({ ledger: db, config, transactionVerifier: verifier });
    expect(await service.notification('signed')).toEqual({ handled: true });
    expect(await service.notification('signed')).toEqual({ handled: false });
    expect(db.getAccount(account.id)?.credits).toBe(1);
  });
  it('rejects production sandbox and malformed config', () => {
    expect(() =>
      appleBillingConfig({
        NODE_ENV: 'production',
        AUX_APPLE_BUNDLE_ID: config.bundleId,
        AUX_APPLE_ENVIRONMENT: 'Sandbox',
      }),
    ).toThrow('Sandbox');
    expect(() =>
      appleBillingConfig({
        AUX_APPLE_BUNDLE_ID: config.bundleId,
        AUX_APPLE_GAME_PRODUCTS: '{"p":-1}',
      }),
    ).toThrow('credits');
  });
  it('exposes only configured purchases and requires a session for accounts', async () => {
    const db = ledger(),
      app = Fastify();
    await app.register(
      billingRoute({ service: new BillingService({ ledger: db, config: null }) }),
      { prefix: '/api/v1' },
    );
    try {
      expect((await app.inject('/api/v1/billing/config')).json().data.purchasesAvailable).toBe(
        false,
      );
      expect((await app.inject('/api/v1/billing/account')).statusCode).toBe(401);
      expect(
        (await app.inject({ method: 'POST', url: '/api/v1/billing/challenge' })).statusCode,
      ).toBe(503);
      const { token, account } = db.createHostSession('h');
      const res = await app.inject({
        url: '/api/v1/billing/account',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.json().data.account.id).toBe(account.id);
      expect(res.headers['cache-control']).toContain('no-store');
      expect(
        (
          await app.inject({
            method: 'DELETE',
            url: '/api/v1/billing/account',
            headers: { authorization: `Bearer ${token}` },
          })
        ).statusCode,
      ).toBe(200);
      expect(db.authorizeSession(token)).toBeNull();
    } finally {
      await app.close();
    }
  }, 15_000);
  it('rejects invalid positive-integer limits', () => {
    expect(() => ledger({ maxRoundsPerGame: 0 })).toThrow();
    expect(new BillingError('x', 'x').statusCode).toBe(403);
  });
});

describe('Apple authorization exchange and account deletion', () => {
  it('uses fixed Apple endpoints and a signed client secret, then revokes the refresh token', async () => {
    const { privateKey } = await generateKeyPair('ES256', { extractable: true });
    const requests: Array<{ url: string; body: URLSearchParams }> = [];
    const transport = (async (input, init) => {
      requests.push({ url: String(input), body: new URLSearchParams(String(init?.body)) });
      return new Response(
        String(input).endsWith('/token')
          ? JSON.stringify({ refresh_token: 'private-refresh', id_token: 'identity' })
          : '',
        { status: 200 },
      );
    }) as typeof fetch;
    const client = new AppleAuthorization(
      {
        clientId: config.bundleId,
        teamId: 'TEAM',
        keyId: 'KEY',
        privateKeyPem: await exportPKCS8(privateKey),
        encryptionKey: Buffer.alloc(32, 1),
      },
      transport,
    );
    expect(await client.exchange('code')).toEqual({
      refreshToken: 'private-refresh',
      identityToken: 'identity',
    });
    await client.revoke('private-refresh');
    expect(requests.map((r) => r.url)).toEqual([
      'https://appleid.apple.com/auth/token',
      'https://appleid.apple.com/auth/revoke',
    ]);
    expect(requests[0]!.body.get('code')).toBe('code');
    expect(requests[0]!.body.get('grant_type')).toBe('authorization_code');
    expect(requests[0]!.body.get('client_secret')?.split('.')).toHaveLength(3);
    expect(requests[1]!.body.get('token_type_hint')).toBe('refresh_token');
  });
  it('encrypts grants with account binding and keeps account intact when revocation fails', async () => {
    const db = ledger();
    const key = Buffer.alloc(32, 7);
    let revokeFails = true,
      revoked = '';
    const authConfig = {
      ...config,
      requireAuthorization: true,
      authorization: {
        clientId: config.bundleId,
        teamId: 'TEAM',
        keyId: 'KEY',
        privateKeyPem: 'injected-test-client',
        encryptionKey: key,
      },
    };
    let nonce = '';
    const service = new BillingService({
      ledger: db,
      config: authConfig,
      identityVerifier: { verify: async () => ({ subject: 'apple-user', nonce }) },
      transactionVerifier: null,
      authorizationClient: {
        exchange: async () => ({
          refreshToken: 'secret-refresh-token',
          identityToken: 'exchanged-proof',
        }),
        revoke: async (token) => {
          if (revokeFails) throw new Error('temporary Apple outage');
          revoked = token;
        },
      },
    });
    const challenge = service.challenge();
    nonce = challenge.nonce;
    await expect(service.signIn('identity', challenge.challengeId)).rejects.toThrow(
      'complete Apple',
    );
    const session = await service.signIn('identity', challenge.challengeId, 'code');
    const encrypted = db.getAppleAuthorizations(session.account.id)[0]!;
    expect(encrypted).not.toContain('secret-refresh-token');
    expect(decryptRefreshToken(encrypted, session.account.id, key)).toBe('secret-refresh-token');
    expect(() => decryptRefreshToken(encrypted, 'another-account', key)).toThrow();
    await expect(service.deleteAccount(session.account)).rejects.toThrow('temporary');
    expect(db.authorizeSession(session.token)).not.toBeNull();
    revokeFails = false;
    await service.deleteAccount(session.account);
    expect(revoked).toBe('secret-refresh-token');
    expect(db.authorizeSession(session.token)).toBeNull();
    expect(db.getAppleAuthorizations(session.account.id)).toEqual([]);
    const original = encryptRefreshToken('token', 'account', key);
    const tampered = (original[0] === 'x' ? 'y' : 'x') + original.slice(1);
    expect(() => decryptRefreshToken(tampered, 'account', key)).toThrow();
  });
  it('fails closed for production sign-in without authorization/revocation credentials', () => {
    const db = ledger();
    const service = new BillingService({
      ledger: db,
      config: { ...config, requireAuthorization: true },
      transactionVerifier: null,
    });
    expect(service.publicConfig().signInAvailable).toBe(false);
    expect(() => service.challenge()).toThrow('not configured');
  });
});

describe('billing operational safeguards', () => {
  it('persists nonpersonal model metrics, pending requests and immutable settlements', () => {
    const db = ledger({ dailyBudgetMicros: 100, monthlyBudgetMicros: 100 });
    const { account } = db.createHostSession('h');
    db.reserveGame(account.id, 'r');
    db.reserveAiAttempt({ id: 'a', roomCode: 'r', maxCostMicros: 20 });
    db.reserveAiAttempt({ id: 'b', roomCode: 'r', maxCostMicros: 20 });
    db.settleAiAttempt('a', {
      costMicros: 10,
      model: 'test-model',
      promptVersion: 'v2',
      status: 'success',
      durationMs: 123,
    });
    const result = db.getMetrics();
    expect(result.attempts).toBe(2);
    expect(result.successes).toBe(1);
    expect(result.pending).toBe(1);
    expect(result.totalCostMicros).toBe(30);
    expect(result.meanDurationMs).toBe(123);
  });
  it('preserves refund debt on deletion and blocks racing game/purchase/sign-in changes', () => {
    const db = ledger({ trialCredits: 0 });
    const { account } = db.createHostSession('h');
    db.grantPurchase({ transactionId: 't', accountId: account.id, productId: 'p', credits: 1 });
    db.reserveGame(account.id, 'r');
    db.revokePurchase('t', 'n');
    db.beginAccountDeletion(account.id);
    expect(() => db.createHostSession('h')).toThrow('deletion');
    expect(() => db.reserveGame(account.id, 'r')).toThrow('deletion');
    expect(() =>
      db.grantPurchase({ transactionId: 't2', accountId: account.id, productId: 'p', credits: 1 }),
    ).toThrow('deletion');
    db.deleteAccount(account.id);
    db.endAccountDeletion(account.id);
    expect(db.createHostSession('h').account.credits).toBe(-1);
    expect(db.refundGame('r', 'late-outage')).toBe(false);
  });
});
