/**
 * Server config (TDD §3): env-driven, no ambient secrets.
 * Dev mode gates the /dev dashboard (D-011) — never on in production.
 */
export interface ServerConfig {
  port: number;
  host: string;
  /** Dev-only debug surface. */
  devMode: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  // Validate instead of trusting casts: an invalid pino level throws deep
  // inside the logger at boot; NaN port fails opaquely in listen().
  const candidate = env.LOG_LEVEL as ServerConfig['logLevel'];
  const parsedPort = Number(env.PORT ?? 8787);
  return {
    port: Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : 8787,
    host: env.HOST ?? '0.0.0.0',
    devMode: env.AUX_DEV_MODE === '1',
    logLevel: LOG_LEVELS.includes(candidate)
      ? candidate
      : env.NODE_ENV !== 'production'
        ? 'info'
        : 'warn',
  };
}
