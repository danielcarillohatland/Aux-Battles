import { readFileSync } from 'node:fs';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import {
  Environment,
  SignedDataVerifier,
  Type,
  type JWSTransactionDecodedPayload,
  type ResponseBodyV2DecodedPayload,
} from '@apple/app-store-server-library';
import { BillingError } from './ledger.js';
import type { AppleAuthorizationConfig } from './apple-authorization.js';

export interface VerifiedAppleIdentity {
  subject: string;
  nonce: string;
}
export interface AppleIdentityVerifier {
  verify(identityToken: string): Promise<VerifiedAppleIdentity>;
}

/** Apple's public keys are fetched from a fixed trusted endpoint and cached by jose. */
export class AppleSignInVerifier implements AppleIdentityVerifier {
  private readonly keys: JWTVerifyGetKey;
  constructor(
    private readonly audience: string,
    keys?: JWTVerifyGetKey,
  ) {
    if (!audience) throw new Error('Apple Sign in audience must be configured');
    this.keys =
      keys ??
      createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'), {
        timeoutDuration: 5_000,
        cooldownDuration: 30_000,
      });
  }
  async verify(identityToken: string): Promise<VerifiedAppleIdentity> {
    try {
      const { payload } = await jwtVerify(identityToken, this.keys, {
        issuer: 'https://appleid.apple.com',
        audience: this.audience,
        algorithms: ['RS256'],
        requiredClaims: ['sub', 'exp', 'iat', 'nonce'],
        maxTokenAge: '10m',
        clockTolerance: 5,
      });
      if (
        typeof payload.sub !== 'string' ||
        !payload.sub ||
        typeof payload.nonce !== 'string' ||
        !payload.nonce
      )
        throw new Error('Missing subject or nonce');
      return { subject: payload.sub, nonce: payload.nonce };
    } catch {
      throw new BillingError(
        'INVALID_APPLE_IDENTITY',
        'Apple sign-in could not be verified. Please sign in again.',
        401,
      );
    }
  }
}
export interface AppleTransactionVerifier {
  verifyAndDecodeTransaction(jws: string): Promise<JWSTransactionDecodedPayload>;
  verifyAndDecodeNotification(jws: string): Promise<ResponseBodyV2DecodedPayload>;
}
export interface AppleBillingConfig {
  bundleId: string;
  signInAudience: string;
  environment: Environment.PRODUCTION | Environment.SANDBOX;
  appAppleId?: number;
  rootCertificateFiles: string[];
  products: Record<string, number>;
  authorization?: AppleAuthorizationConfig;
  requireAuthorization?: boolean;
}
export function appleBillingConfig(env: NodeJS.ProcessEnv): AppleBillingConfig | null {
  const bundleId = env.AUX_APPLE_BUNDLE_ID?.trim();
  if (!bundleId) return null;
  const environment = env.AUX_APPLE_ENVIRONMENT?.trim() ?? 'Production';
  if (environment !== Environment.PRODUCTION && environment !== Environment.SANDBOX)
    throw new Error('AUX_APPLE_ENVIRONMENT must be Production or Sandbox');
  if (env.NODE_ENV === 'production' && environment !== Environment.PRODUCTION)
    throw new Error('Sandbox purchases cannot fund production AI');
  const appAppleId = !env.AUX_APPLE_APP_ID?.trim() ? undefined : Number(env.AUX_APPLE_APP_ID);
  if (appAppleId !== undefined && (!Number.isSafeInteger(appAppleId) || appAppleId <= 0))
    throw new Error('AUX_APPLE_APP_ID must be a positive App Store identifier');
  const products: Record<string, number> = Object.create(null) as Record<string, number>;
  const rawProducts: unknown = JSON.parse(env.AUX_APPLE_GAME_PRODUCTS ?? '{}');
  if (!rawProducts || typeof rawProducts !== 'object' || Array.isArray(rawProducts))
    throw new Error('AUX_APPLE_GAME_PRODUCTS must map product IDs to game credits');
  for (const [product, credits] of Object.entries(rawProducts)) {
    if (
      !product ||
      product.length > 255 ||
      typeof credits !== 'number' ||
      !Number.isSafeInteger(credits) ||
      credits < 1 ||
      credits > 1000
    )
      throw new Error('Each Apple game product needs 1–1000 credits');
    products[product] = credits;
  }
  const rootCertificateFiles = (env.AUX_APPLE_ROOT_CERT_FILES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (
    Object.keys(products).length &&
    (!rootCertificateFiles.length ||
      (environment === Environment.PRODUCTION && appAppleId === undefined))
  )
    throw new Error(
      'Apple purchases require trusted root certificates and a production App Store ID',
    );
  const signInAudience = env.AUX_APPLE_SIGN_IN_AUDIENCE?.trim() || bundleId;
  const authFields = [
    env.AUX_APPLE_TEAM_ID,
    env.AUX_APPLE_SIGN_IN_KEY_ID,
    env.AUX_APPLE_SIGN_IN_PRIVATE_KEY_FILE,
    env.AUX_APPLE_REFRESH_ENCRYPTION_KEY,
  ];
  let authorization: AppleAuthorizationConfig | undefined;
  if (authFields.some(Boolean)) {
    if (!authFields.every((value) => value?.trim()))
      throw new Error(
        'Apple authorization requires team ID, key ID, private key file and refresh-token encryption key',
      );
    const encryptionKey = Buffer.from(env.AUX_APPLE_REFRESH_ENCRYPTION_KEY!.trim(), 'base64');
    if (
      encryptionKey.length !== 32 ||
      encryptionKey.toString('base64') !== env.AUX_APPLE_REFRESH_ENCRYPTION_KEY!.trim()
    )
      throw new Error('AUX_APPLE_REFRESH_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
    authorization = {
      clientId: signInAudience,
      teamId: env.AUX_APPLE_TEAM_ID!.trim(),
      keyId: env.AUX_APPLE_SIGN_IN_KEY_ID!.trim(),
      privateKeyPem: readFileSync(env.AUX_APPLE_SIGN_IN_PRIVATE_KEY_FILE!.trim(), 'utf8'),
      encryptionKey,
    };
  }
  return {
    bundleId,
    signInAudience,
    requireAuthorization: env.NODE_ENV === 'production',
    ...(authorization ? { authorization } : {}),
    environment,
    rootCertificateFiles,
    products,
    ...(appAppleId === undefined ? {} : { appAppleId }),
  };
}
export function createAppleTransactionVerifier(
  config: AppleBillingConfig,
): AppleTransactionVerifier | null {
  if (!config.rootCertificateFiles.length) return null;
  return new SignedDataVerifier(
    config.rootCertificateFiles.map((file) => readFileSync(file)),
    true,
    config.environment,
    config.bundleId,
    config.appAppleId,
  );
}
export function validateGameTransaction(
  tx: JWSTransactionDecodedPayload,
  config: AppleBillingConfig,
): { transactionId: string; productId: string; accountToken: string; credits: number } {
  const credits =
    tx.productId && Object.hasOwn(config.products, tx.productId)
      ? config.products[tx.productId]
      : undefined;
  if (
    tx.bundleId !== config.bundleId ||
    tx.environment !== config.environment ||
    tx.type !== Type.CONSUMABLE ||
    !tx.transactionId ||
    !tx.appAccountToken ||
    !tx.productId ||
    !credits ||
    tx.quantity !== 1 ||
    tx.inAppOwnershipType !== 'PURCHASED'
  )
    throw new BillingError('INVALID_PURCHASE', 'This transaction is not a supported game pack');
  if (tx.revocationDate !== undefined)
    throw new BillingError('PURCHASE_REVOKED', 'This purchase was refunded');
  if (!Number.isFinite(tx.purchaseDate) || tx.purchaseDate! > Date.now() + 60_000)
    throw new BillingError('INVALID_PURCHASE', 'Invalid purchase date');
  return {
    transactionId: tx.transactionId,
    productId: tx.productId,
    accountToken: tx.appAccountToken.toLowerCase(),
    credits,
  };
}
