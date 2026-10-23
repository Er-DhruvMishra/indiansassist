import { defineConfig } from 'vitest/config';
import { buildEnv, defines } from './scripts/env.mjs';

// Tests compile against a fixed region list so handshake tests are deterministic.
const cfg = buildEnv({
  IA_DEV: '1',
  VITE_REGION_ORIGINS: 'in-mum=https://in.indiansassist.example,eu-fra=https://eu.indiansassist.example',
  VITE_API_URL: 'http://localhost:4000',
});

export default defineConfig({
  define: defines(cfg),
  test: {
    name: 'extension',
    include: ['test/**/*.test.ts'],
    environment: 'node',
    restoreMocks: true,
  },
});
