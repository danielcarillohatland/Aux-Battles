/**
 * Spotify host OAuth — Authorization Code + PKCE, server-side (TDD §7).
 * Spike scope (Phase 2.5, D-014): verify real Dev Mode behavior before anything
 * builds on it. node:crypto only; network via injectable fetch.
 *
 * Pieces:
 *  - PkceStateStore   in-memory state→verifier map, 10-min TTL (CSRF + PKCE)
 *  - SpotifyOAuth     token exchange / refresh / /me against accounts.spotify.com
 *  - SpotifyTokenStore interface (tests fake this)
 *  - EncryptedSpotifyTokenStore  aes-256-gcm at-rest encryption + proactive
 *    refresh T-120s before expiry on every read
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';

const ACCOUNTS_BASE = 'https://accounts.spotify.com';
const API_BASE = 'https://api.spotify.com/v1';

/** TDD §7 minimal scopes: playback control + playback read + identity. */
export const SPOTIFY_SCOPES = [
  'user-modify-playback-state',
  'user-read-playback-state',
  'user-read-email',
] as const;

/** Epoch-ms expiry. `refreshToken` null when Spotify omits it (subsequent grants). */
export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  scope: string | null;
}

export interface SpotifyUser {
  id: string;
  displayName: string | null;
}

export function loadSpotifyEnv(env: NodeJS.ProcessEnv): {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
} | null {
  const clientId = env.SPOTIFY_CLIENT_ID?.trim();
  const clientSecret = env.SPOTIFY_CLIENT_SECRET?.trim();
  const redirectUri = env.SPOTIFY_REDIRECT_URI?.trim();
  if (!clientId || !clientSecret || !redirectUri) return null;
  return { clientId, clientSecret, redirectUri };
}

// ---------------------------------------------------------------------------
// PKCE + CSRF state
// ---------------------------------------------------------------------------

export function pkcePair(): { verifier: string; challenge: string } {
  // RFC 7636: 43-128 chars of unreserved chars. 64 random bytes ≈ 86 b64url chars.
  const verifier = randomBytes(64).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

interface PendingAuth {
  verifier: string;
  expiresAt: number;
}

/**
 * state → PKCE verifier, one-time consume, hard 10-minute TTL (task contract).
 * Expired/unknown states are indistinguishable to callers (both → null).
 */
export class PkceStateStore {
  private readonly pending = new Map<string, PendingAuth>();

  constructor(
    private readonly ttlMs = 10 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Mints state + challenge and remembers the verifier server-side. */
  create(): { state: string; challenge: string } {
    this.sweep();
    const state = randomBytes(32).toString('base64url');
    const { verifier, challenge } = pkcePair();
    this.pending.set(state, { verifier, expiresAt: this.now() + this.ttlMs });
    return { state, challenge };
  }

  /** One-time: returns the verifier iff state is live, then forgets it. */
  consume(state: string): string | null {
    const entry = this.pending.get(state);
    if (entry === undefined) return null;
    this.pending.delete(state);
    if (this.now() >= entry.expiresAt) return null;
    return entry.verifier;
  }

  get size(): number {
    return this.pending.size;
  }

  private sweep(): void {
    const now = this.now();
    for (const [state, entry] of this.pending) {
      if (now >= entry.expiresAt) this.pending.delete(state);
    }
  }
}

// ---------------------------------------------------------------------------
// OAuth client (network boundary)
// ---------------------------------------------------------------------------

export interface SpotifyOAuthOptions {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes?: readonly string[];
  fetchImpl?: typeof fetch;
}

export class InvalidGrantError extends Error {
  constructor(message = 'spotify rejected the grant (re-auth required)') {
    super(message);
    this.name = 'InvalidGrantError';
  }
}

export class SpotifyOAuthError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'SpotifyOAuthError';
  }
}

export class SpotifyOAuth {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: SpotifyOAuthOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  authorizeUrl(challenge: string, state: string): string {
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: this.opts.clientId,
      scope: (this.opts.scopes ?? SPOTIFY_SCOPES).join(' '),
      redirect_uri: this.opts.redirectUri,
      state,
      code_challenge_method: 'S256',
      code_challenge: challenge,
    });
    return `${ACCOUNTS_BASE}/authorize?${q.toString()}`;
  }

  async exchangeCode(code: string, verifier: string): Promise<TokenSet> {
    return this.tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.opts.redirectUri,
      client_id: this.opts.clientId,
      code_verifier: verifier,
    });
  }

  async refresh(refreshToken: string): Promise<TokenSet> {
    return this.tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: this.opts.clientId,
    });
  }

  async me(accessToken: string): Promise<SpotifyUser> {
    const res = await this.fetchImpl(`${API_BASE}/me`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      throw new SpotifyOAuthError(res.status, `GET /me failed (${res.status})`);
    }
    const body = (await res.json()) as { id?: unknown; display_name?: unknown };
    if (typeof body.id !== 'string' || body.id.length === 0) {
      throw new SpotifyOAuthError(res.status, 'GET /me returned no user id');
    }
    return {
      id: body.id,
      displayName: typeof body.display_name === 'string' ? body.display_name : null,
    };
  }

  private async tokenRequest(form: Record<string, string>): Promise<TokenSet> {
    const basic = Buffer.from(`${this.opts.clientId}:${this.opts.clientSecret}`).toString('base64');
    let res: Response;
    try {
      res = await this.fetchImpl(`${ACCOUNTS_BASE}/api/token`, {
        method: 'POST',
        headers: {
          authorization: `Basic ${basic}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(form).toString(),
      });
    } catch (err) {
      throw new SpotifyOAuthError(0, `token endpoint unreachable: ${String(err)}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      // invalid_grant is terminal per TDD §7 → re-auth prompt, never retry.
      if (text.includes('invalid_grant')) throw new InvalidGrantError();
      throw new SpotifyOAuthError(res.status, `token endpoint failed (${res.status})`);
    }
    const body = (await res.json()) as {
      access_token?: unknown;
      refresh_token?: unknown;
      expires_in?: unknown;
      scope?: unknown;
    };
    if (typeof body.access_token !== 'string' || typeof body.expires_in !== 'number') {
      throw new SpotifyOAuthError(res.status, 'token endpoint returned malformed payload');
    }
    return {
      accessToken: body.access_token,
      refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : null,
      expiresAt: Date.now() + body.expires_in * 1000,
      scope: typeof body.scope === 'string' ? body.scope : null,
    };
  }
}

// ---------------------------------------------------------------------------
// Token store — encryption at rest + proactive refresh on read
// ---------------------------------------------------------------------------

export interface StoredTokens extends TokenSet {
  spotifyUserId: string | null;
}

export interface SpotifyTokenStore {
  save(sessionToken: string, tokens: StoredTokens): Promise<void>;
  /**
   * Returns live tokens or null (unknown session). Implementations MUST
   * proactively refresh when expiry is within their refresh window.
   */
  load(sessionToken: string): Promise<StoredTokens | null>;
  drop(sessionToken: string): Promise<void>;
}

/** AUX_TOKEN_KEY (preferred) else derived from the client secret (D: env-only secrets). */
export function tokenEncryptionKey(env: NodeJS.ProcessEnv, clientSecret: string): Buffer {
  const raw = env.AUX_TOKEN_KEY?.trim();
  const material = raw !== undefined && raw.length > 0 ? raw : clientSecret;
  if (/^[0-9a-f]{64}$/i.test(material)) return Buffer.from(material, 'hex');
  try {
    const b64 = Buffer.from(material, 'base64');
    if (b64.length === 32 && material.length >= 40) return b64;
  } catch {
    /* fall through to KDF */
  }
  return scryptSync(material, 'aux-battles:token-store:v1', 32);
}

export interface EncryptedStoreOptions {
  key: Buffer;
  oauth: Pick<SpotifyOAuth, 'refresh'>;
  /** Refresh when expiring within this window (default 120s — task contract). */
  refreshWindowMs?: number;
  now?: () => number;
}

interface SealedPayload {
  iv: string;
  tag: string;
  ct: string;
}

function seal(key: Buffer, plaintext: string): SealedPayload {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    ct: ct.toString('base64url'),
  };
}

function unseal(key: Buffer, sealed: SealedPayload): string {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(sealed.ct, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * In-memory encrypted-at-rest store (spike persistence tier). Ciphertext only:
 * plaintext tokens exist solely during encrypt/decrypt/refresh. On every load
 * inside the refresh window it rotates the access token via the refresh grant
 * before handing anything out — callers never see a stale token.
 */
export class EncryptedSpotifyTokenStore implements SpotifyTokenStore {
  private readonly sealed = new Map<string, SealedPayload>();
  private readonly refreshWindowMs: number;
  private readonly now: () => number;

  constructor(private readonly opts: EncryptedStoreOptions) {
    if (opts.key.length !== 32) throw new Error('token encryption key must be 32 bytes');
    this.refreshWindowMs = opts.refreshWindowMs ?? 120_000;
    this.now = opts.now ?? Date.now;
  }

  get size(): number {
    return this.sealed.size;
  }

  async save(sessionToken: string, tokens: StoredTokens): Promise<void> {
    this.sealed.set(sessionToken, seal(this.opts.key, JSON.stringify(tokens)));
  }

  async load(sessionToken: string): Promise<StoredTokens | null> {
    const sealed = this.sealed.get(sessionToken);
    if (sealed === undefined) return null;
    let tokens = JSON.parse(unseal(this.opts.key, sealed)) as StoredTokens;
    const remaining = tokens.expiresAt - this.now();
    if (remaining < this.refreshWindowMs && tokens.refreshToken !== null) {
      // Proactive refresh (T-120s). invalid_grant drops the session so the next
      // read returns null → host is sent through /login again (TDD §7).
      try {
        const fresh = await this.opts.oauth.refresh(tokens.refreshToken);
        tokens = {
          ...tokens,
          accessToken: fresh.accessToken,
          refreshToken: fresh.refreshToken ?? tokens.refreshToken,
          expiresAt: fresh.expiresAt,
          scope: fresh.scope ?? tokens.scope,
        };
        await this.save(sessionToken, tokens);
      } catch (err) {
        if (err instanceof InvalidGrantError) {
          this.sealed.delete(sessionToken);
          return null;
        }
        // Transient failure + still some life left: serve current token.
        if (remaining <= 0) throw err;
      }
    }
    if (tokens.expiresAt - this.now() <= 0) {
      this.sealed.delete(sessionToken);
      return null;
    }
    return tokens;
  }

  async drop(sessionToken: string): Promise<void> {
    this.sealed.delete(sessionToken);
  }
}
