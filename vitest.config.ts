import { defineConfig } from 'vitest/config';

// Frontend unit tests live in web-tests/ — deliberately separate from the
// backend node:test suites in tests/ (run via `tsx --test`, see `npm test`).
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'jsdom',
    include: ['web-tests/**/*.test.{ts,tsx}'],
    setupFiles: ['web-tests/setup.ts'],
    // at most 2 workers (override with VITEST_MAX_WORKERS): several suites
    // often run side by side on one machine
    maxWorkers: Number(process.env.VITEST_MAX_WORKERS) || 2,
  },
});
