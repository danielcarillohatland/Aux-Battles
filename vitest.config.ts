import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/tests/**/*.test.ts', 'apps/*/tests/**/*.test.ts'],
    environment: 'node',
    // Each integration worker boots Fastify/SQLite. Bound parallel workers so
    // CPU contention does not turn the integration-test safety timeout into flakes.
    maxWorkers: 2,
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});
