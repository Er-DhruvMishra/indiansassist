// Vitest project for the root developer scripts (scripts/smoke*, scripts/validate-infra.mjs).
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'scripts',
    root: import.meta.dirname,
    include: ['test/**/*.test.mjs'],
    testTimeout: 30_000,
  },
});
