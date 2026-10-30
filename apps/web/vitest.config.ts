import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    name: 'web',
    include: ['test/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    setupFiles: ['test/setup.ts'],
    restoreMocks: true,
    // A jsdom worker per core alongside the other packages of `pnpm -r test` oversubscribed the machine until forks
    // failed to start ("Timeout waiting for worker to respond"); half the cores keeps the parallel run bounded.
    maxWorkers: '50%',
    // user-event flows in jsdom take 1-3 s alone and over 5 s when `pnpm -r test` runs every package in parallel.
    testTimeout: 20_000,
  },
});
