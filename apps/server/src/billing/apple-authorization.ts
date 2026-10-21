import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { importPKCS8, SignJWT } from 'jose';
import { BillingError } from './ledger.js';

export interface AppleAuthorizationConfig {
  clientId: string;
  teamId: string;
  keyId: string;
  privateKeyPem: string;
  encryptionKey: Buffer;
}
export interface AppleAuthorizationClient {
  exchange(code: string): Promise<{ refreshToken: string; identityToken: string }>;
  revoke(refreshToken: string): Promise<void>;
}
/** Fixed Apple endpoints; no caller-controlled URLs. Secrets never enter logs. */
export class AppleAuthorization implements AppleAuthorizationClient {
  constructor(
    private readonly config: AppleAuthorizationConfig,
    private readonly transport: typeof fetch = fetch,
  ) {}
  private async request(
    path: 'token' | 'revoke',
    values: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    try {
      const key = await importPKCS8(this.config.privateKeyPem, 'ES256');
      const clientSecret = await new SignJWT({})
        .setProtectedHeader({ alg: 'ES256', kid: this.config.keyId })
        .setIssuer(this.config.teamId)
        .setSubject(this.config.clientId)
        .setAudience('https://appleid.apple.com')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(key);
      const response = await this.transport(`https://appleid.apple.com/auth/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: this.config.clientId,
          client_secret: clientSecret,
          ...values,
        }),
        signal: AbortSignal.timeout(10_000),
        redirect: 'error',
      });
      if (!response.ok) throw new Error('Apple rejected authorization');
      if (path === 'revoke') return {};
      const result: unknown = await response.json();
      if (!result || typeof result !== 'object' || Array.isArray(result))
        throw new Error('Invalid Apple response');
      return result as Record<string, unknown>;
    } catch {
      throw new BillingError(
        'APPLE_AUTHORIZATION_UNAVAILABLE',
        'Apple authorization could not be completed. Please try again.',
        503,
      );
    }
  }
  async exchange(code: string): Promise<{ refreshToken: string; identityToken: string }> {
    const response = await this.request('token', { code, grant_type: 'authorization_code' });
    if (
      typeof response.refresh_token !== 'string' ||
      !response.refresh_token ||
      typeof response.id_token !== 'string' ||
      !response.id_token
    )
      throw new BillingError(
        'INVALID_APPLE_AUTHORIZATION',
        'Apple sign-in did not return a valid authorization.',
        401,
      );
    return { refreshToken: response.refresh_token, identityToken: response.id_token };
  }
  async revoke(refreshToken: string): Promise<void> {
    await this.request('revoke', { token: refreshToken, token_type_hint: 'refresh_token' });
  }
}
export function encryptRefreshToken(token: string, accountId: string, key: Buffer): string {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(accountId));
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((b) => b.toString('base64url')).join('.');
}
export function decryptRefreshToken(encrypted: string, accountId: string, key: Buffer): string {
  const [iv, tag, ciphertext, extra] = encrypted.split('.');
  if (!iv || !tag || !ciphertext || extra !== undefined)
    throw new Error('Invalid encrypted authorization');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(accountId));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
