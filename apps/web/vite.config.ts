import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

// Dual-entry build (TDD §9): host.html (desktop/tablet) + player.html (phones).
// Route decides role, never screen size.
export default defineConfig({
  plugins: [solid()],
  server: {
    proxy: {
      // REST mutations go through Vite in dev…
      '/api': 'http://localhost:8787',
      // …and so must the WS upgrade — without this, the host client dials
      // Vite for /ws and loops forever on "Reconnecting…" (ticket mints fine
      // via /api proxy, but the upgrade never reaches Fastify).
      '/ws': { target: 'ws://localhost:8787', ws: true },
    },
  },
  build: {
    rollupOptions: {
      input: {
        host: resolveEntry('host.html'),
        player: resolveEntry('player.html'),
      },
    },
    target: 'es2022',
  },
});

/** Absolute fs path for a repo-relative entry. fileURLToPath (not URL.pathname)
 * so Windows drive letters (`/C:/…`) and percent-encoded path segments survive. */
function resolveEntry(p: string): string {
  return fileURLToPath(new URL(p, import.meta.url));
}
