import { describe, expect, it } from 'vitest';
import {
  allowedOriginsFromEnv,
  isAllowedCrossOrigin,
  isAllowedWebSocketOrigin,
  normalizeOrigin,
} from '../src/core/origins.js';
import { buildServer } from '../src/index.js';

describe('native app origin policy', () => {
  const allowed = allowedOriginsFromEnv({
    AUX_ALLOWED_ORIGINS: 'https://play.auxbattles.game',
  });

  it('normalizes standard and Capacitor origins', () => {
    expect(normalizeOrigin('capacitor://localhost')).toBe('capacitor://localhost');
    expect(normalizeOrigin('HTTPS://Example.COM/path')).toBe('https://example.com');
  });

  it('allows only the native shell and explicit cross-origin clients', () => {
    expect(isAllowedCrossOrigin('capacitor://localhost', allowed)).toBe(true);
    expect(isAllowedCrossOrigin('https://localhost', allowed)).toBe(true);
    expect(isAllowedCrossOrigin('https://play.auxbattles.game', allowed)).toBe(true);
    expect(isAllowedCrossOrigin('https://attacker.example', allowed)).toBe(false);
  });

  it('keeps same-origin websockets and permits the native shell explicitly', () => {
    expect(isAllowedWebSocketOrigin('https://api.example', 'api.example', allowed)).toBe(true);
    expect(isAllowedWebSocketOrigin('capacitor://localhost', 'api.example', allowed)).toBe(true);
    expect(isAllowedWebSocketOrigin('https://attacker.example', 'api.example', allowed)).toBe(
      false,
    );
    expect(isAllowedWebSocketOrigin('not a url', 'api.example', allowed)).toBe(false);
  });

  it('answers native preflights without opening the API to arbitrary websites', async () => {
    const { app } = await buildServer({
      LOG_LEVEL: 'error',
      AUX_DEV_MODE: '0',
      AUX_DB_FILE: ':memory:',
    });

    try {
      const native = await app.inject({
        method: 'OPTIONS',
        url: '/api/v1/rooms',
        headers: {
          origin: 'capacitor://localhost',
          'access-control-request-method': 'POST',
        },
      });
      expect(native.statusCode).toBe(204);
      expect(native.headers['access-control-allow-origin']).toBe('capacitor://localhost');

      const attacker = await app.inject({
        method: 'OPTIONS',
        url: '/api/v1/rooms',
        headers: {
          origin: 'https://attacker.example',
          'access-control-request-method': 'POST',
        },
      });
      expect(attacker.headers['access-control-allow-origin']).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});
