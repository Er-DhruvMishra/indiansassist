// drizzle-kit config: `pnpm --filter @indiansassist/db db:generate` writes SQL to ./drizzle (journal committed).
// Custom SQL (triggers) is added with `db:custom` (drizzle-kit generate --custom). No DB connection needed.
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/tables.ts',
  out: './drizzle',
  strict: true,
  verbose: true,
});
