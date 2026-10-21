/** Capacitor's default local origins. These are app shells, not public websites. */
export const NATIVE_APP_ORIGINS = [
  'capacitor://localhost',
  'http://localhost',
  'https://localhost',
] as const;

export function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.host === '') return null;
    return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}`;
  } catch {
    return null;
  }
}

export function allowedOriginsFromEnv(env: NodeJS.ProcessEnv): ReadonlySet<string> {
  const origins = new Set<string>(NATIVE_APP_ORIGINS);
  for (const candidate of (env.AUX_ALLOWED_ORIGINS ?? '').split(',')) {
    const normalized = normalizeOrigin(candidate.trim());
    if (normalized !== null) origins.add(normalized);
  }
  return origins;
}

export function isAllowedCrossOrigin(
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>,
): boolean {
  if (origin === undefined) return true;
  const normalized = normalizeOrigin(origin);
  return normalized !== null && allowedOrigins.has(normalized);
}

export function isAllowedWebSocketOrigin(
  origin: string | undefined,
  hostHeader: string | undefined,
  allowedOrigins: ReadonlySet<string>,
): boolean {
  if (origin === undefined) return true;
  const normalized = normalizeOrigin(origin);
  if (normalized === null) return false;
  try {
    if (hostHeader && new URL(normalized).host.toLowerCase() === hostHeader.toLowerCase())
      return true;
  } catch {
    return false;
  }
  return allowedOrigins.has(normalized);
}
