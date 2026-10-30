import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'api',
    include: ['test/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['test/global-setup.ts'],
    // Every file runs its own PGlite (about 0.5 GB committed with the app) and timing-sensitive signaling tests:
    // one worker per core exhausted the commit charge on a 16 GB machine (argon2's 64 MiB signup hash then fails
    // with a 500) and starved timers. Half the cores keeps the run bounded wherever it runs.
    maxWorkers: '50%',
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
