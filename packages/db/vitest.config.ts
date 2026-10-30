import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'db',
    include: ['test/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['test/global-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
