const stripTrailingSlash = (value: string): string => value.trim().replace(/\/+$/, '');

function configuredOrigin(key: 'VITE_AUX_API_ORIGIN' | 'VITE_AUX_PUBLIC_ORIGIN'): string | null {
  const value = import.meta.env[key]?.trim();
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/** REST origin is empty for the normal same-origin web build. */
export function apiOrigin(): string | null {
  return configuredOrigin('VITE_AUX_API_ORIGIN');
}

/** Public web URL used by the host's join QR inside the native app. */
export function publicAppOrigin(): string | null {
  return configuredOrigin('VITE_AUX_PUBLIC_ORIGIN') ?? apiOrigin();
}

export function apiUrl(path: string, origin: string | null = apiOrigin()): string {
  if (/^https?:\/\//i.test(path)) return path;
  if (origin === null) return path;
  return `${stripTrailingSlash(origin)}${path.startsWith('/') ? path : `/${path}`}`;
}

function localWebOrigin(): string {
  const location = globalThis.location;
  if (location === undefined) return 'http://localhost';
  return location.origin || `${location.protocol}//${location.host}`;
}

export function webSocketUrl(path: string, origin: string | null = apiOrigin()): string {
  const base = origin ?? localWebOrigin();
  const url = new URL(path, `${stripTrailingSlash(base)}/`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}
