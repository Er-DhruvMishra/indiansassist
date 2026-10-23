// Root vitest config: runs every package's and app's own vitest project from the repo root
// (`pnpm exec vitest run`). Vitest 5 replaced vitest.workspace.ts with `test.projects`.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*/vitest.config.ts', 'apps/*/vitest.config.ts', 'scripts/vitest.config.mjs'],
  },
});
