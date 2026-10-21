import type { FastifyPluginAsync } from 'fastify';

export interface PublicAppConfig {
  publisherName: string | null;
  privacyUrl: string | null;
  termsUrl: string | null;
  supportUrl: string | null;
  reportsAvailable: boolean;
}

function publicLink(value: string | undefined, name: string): string | null {
  const text = value?.trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    if (text.length > 2048 || url.protocol !== 'https:' || url.username || url.password)
      throw new Error();
    return url.href;
  } catch {
    throw new Error(`${name} must be a public HTTPS URL without embedded credentials`);
  }
}

/** An explicit allowlist: the public response never copies the operator's environment. */
export function publicAppConfigFromEnv(
  env: NodeJS.ProcessEnv,
  options: { reportsAvailable: boolean },
): PublicAppConfig {
  const publisherName = env['AUX_PUBLISHER_NAME']?.trim() || null;
  if (publisherName && (publisherName.length > 120 || /[\u0000-\u001f\u007f]/u.test(publisherName)))
    throw new Error('AUX_PUBLISHER_NAME must be a plain publisher name of at most 120 characters');
  return {
    publisherName,
    // The bundled /privacy.html is the default once the public origin is known.
    privacyUrl:
      publicLink(env['AUX_PRIVACY_URL'], 'AUX_PRIVACY_URL') ??
      publicLink(
        env['AUX_PUBLIC_ORIGIN']?.trim()
          ? `${env['AUX_PUBLIC_ORIGIN'].trim().replace(/\/+$/, '')}/privacy.html`
          : undefined,
        'AUX_PUBLIC_ORIGIN',
      ),
    termsUrl: publicLink(env['AUX_TERMS_URL'], 'AUX_TERMS_URL'),
    supportUrl: publicLink(env['AUX_SUPPORT_URL'], 'AUX_SUPPORT_URL'),
    reportsAvailable: options.reportsAvailable,
  };
}

export function appConfigRoute(options: { config: PublicAppConfig }): FastifyPluginAsync {
  return async (app) => {
    app.get('/app-config', async (_request, reply) => {
      reply.header('cache-control', 'public, max-age=60');
      return { ok: true, data: options.config };
    });
  };
}
