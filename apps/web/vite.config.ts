import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import solid from 'vite-plugin-solid';

export function createDevProxy(apiOrigin = 'http://127.0.0.1:8787') {
  const wsOrigin = apiOrigin.replace(/^http/, 'ws');
  return {
    '/api': { target: apiOrigin, changeOrigin: false },
    '/ws': { target: wsOrigin, ws: true, changeOrigin: false },
  };
}

/** Validated `https://host` origin, or null when unset. */
export function publicOrigin(value: string | undefined): string | null {
  const text = value?.trim();
  if (!text) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error('AUX_PUBLIC_ORIGIN must be an absolute URL such as https://aux.example.com');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/') {
    throw new Error('AUX_PUBLIC_ORIGIN must be an HTTPS origin without credentials or a path.');
  }
  return url.origin;
}

/**
 * Link previews need absolute URLs, but the domain is a deploy-time choice
 * (Fly address now, a portfolio subdomain later). With AUX_PUBLIC_ORIGIN set,
 * relative og:image paths become absolute and the landing page gets og:url.
 */
export function absoluteShareLinks(html: string, origin: string | null): string {
  if (origin === null) return html;
  return html
    .replace(/(property="og:image" content=")\//g, `$1${origin}/`)
    .replace(
      '<meta property="og:type"',
      `<meta property="og:url" content="${origin}/" />\n    <meta property="og:type"`,
    );
}

// Dual-entry build (TDD §9): host.html (desktop/tablet) + player.html (phones).
// Route decides role, never screen size.
export default defineConfig(({ mode }) => {
  if (mode === 'mobile') {
    const env = { ...loadEnv(mode, process.cwd()), ...process.env };
    for (const key of ['VITE_AUX_API_ORIGIN', 'VITE_AUX_PUBLIC_ORIGIN']) {
      let url: URL;
      try {
        url = new URL(env[key] ?? '');
      } catch {
        throw new Error(
          `${key} is required. Run npm run ios:prepare with ios.release.json configured.`,
        );
      }
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.pathname !== '/' ||
        url.search ||
        url.hash
      ) {
        throw new Error(`${key} must be an HTTPS origin without credentials or a path.`);
      }
    }
  }
  const origin = publicOrigin(process.env.AUX_PUBLIC_ORIGIN);
  return {
    plugins: [
      solid(),
      {
        name: 'aux-share-links',
        transformIndexHtml: (html: string) => absoluteShareLinks(html, origin),
      },
    ],
    resolve: {
      // Serve the shared package from source in dev/build so a stale compiled
      // dist can never make the client's zod parsers silently strip new fields.
      alias: {
        '@aux/shared': fileURLToPath(
          new URL('../../packages/shared/src/index.ts', import.meta.url),
        ),
      },
    },
    server: {
      // The dev UI is intentionally opened by phones/tablets on the LAN.
      host: '0.0.0.0',
      port: 5173,
      strictPort: true,
      // The host screen is opened by the Mac's mDNS name (D-030: YouTube refuses
      // embeds on IP-address origins). A leading dot allows the whole domain, so
      // any "*.local" hostname works even after the machine is renamed, while
      // Vite's host check stays on for everything else. localhost and IPs are
      // always allowed by Vite itself.
      allowedHosts: ['.local'],
      proxy: {
        // REST mutations go through Vite in dev…
        ...createDevProxy(),
        // …and so must the WS upgrade — without this, the host client dials
        // Vite for /ws and loops forever on "Reconnecting…" (ticket mints fine
        // via /api proxy, but the upgrade never reaches Fastify).
        // Preserve the browser-facing Host header. Fastify compares it with the
        // browser's Origin during the upgrade; rewriting Host to 127.0.0.1:8787
        // makes every genuine LAN browser upgrade look cross-origin and returns
        // 403, while origin-less Node probes misleadingly succeed.
      },
    },
    build: {
      ...(mode === 'mobile' ? { outDir: 'dist-mobile' } : {}),
      rollupOptions: {
        input: {
          index: resolveEntry('index.html'),
          host: resolveEntry('host.html'),
          player: resolveEntry('player.html'),
        },
      },
      target: ['es2020', 'safari15'],
    },
  };
});

/** Absolute fs path for a repo-relative entry. fileURLToPath (not URL.pathname)
 * so Windows drive letters (`/C:/…`) and percent-encoded path segments survive. */
function resolveEntry(p: string): string {
  return fileURLToPath(new URL(p, import.meta.url));
}
