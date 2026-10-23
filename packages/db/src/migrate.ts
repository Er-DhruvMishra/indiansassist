/**
 * Applies the drizzle-kit migrations in packages/db/drizzle (journal committed) on either driver, then, on real
 * Postgres only, revokes UPDATE / DELETE / TRUNCATE on the append-only tables from `DB_APP_ROLE` (section 4.2).
 */
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { migrate as migrateNodePg } from 'drizzle-orm/node-postgres/migrator';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { driverOf, type Db } from './client.js';
import type { Schema } from './schema/index.js';

/** Absolute path of the committed migrations folder (works from src/ under vitest and from dist/). */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../drizzle', import.meta.url));

export type MigrateOptions = {
  /** Role to REVOKE from; defaults to env `DB_APP_ROLE`. Ignored on PGlite. */
  appRole?: string | null;
  migrationsFolder?: string;
};

const ROLE_RE = /^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/;

export async function migrate(db: Db, opts: MigrateOptions = {}): Promise<void> {
  const migrationsFolder = opts.migrationsFolder ?? MIGRATIONS_FOLDER;
  const kind = driverOf(db);
  if (kind === 'pglite') {
    await migratePglite(db as unknown as PgliteDatabase<Schema>, { migrationsFolder });
    return;
  }
  await migrateNodePg(db as unknown as NodePgDatabase<Schema>, { migrationsFolder });
  const role = opts.appRole === undefined ? (process.env['DB_APP_ROLE'] ?? '') : (opts.appRole ?? '');
  if (role.trim() !== '') await revokeAppRole(db, role.trim());
}

async function revokeAppRole(db: Db, role: string): Promise<void> {
  if (!ROLE_RE.test(role)) throw new Error('DB_APP_ROLE is not a valid role name');
  const ident = '"' + role.replace(/"/g, '""') + '"';
  await db.execute(sql.raw(`REVOKE UPDATE, DELETE, TRUNCATE ON audit_entry, audit_checkpoint FROM ${ident}`));
}
