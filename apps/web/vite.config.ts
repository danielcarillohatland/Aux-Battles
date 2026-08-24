import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

// Dual-entry build (TDD §9): host.html (desktop/tablet) + player.html (phones).
// Route decides role, never screen size.
export default defineConfig({
  plugins: [solid()],
  server: {
    proxy: {
      '/api': 'http://localhost:8787',
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
