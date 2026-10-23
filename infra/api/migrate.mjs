// One-shot migration runner for the Compose `migrate` service (copied into the api image as
// /app/apps/api/ia-migrate.mjs by apps/api/Dockerfile, so `@indiansassist/db` resolves through apps/api).
//
// 1. applies the drizzle migrations with the OWNER connection (MIGRATE_DATABASE_URL, contracts 4.2 / 11.1);
// 2. on real Postgres, grants the app role (DB_APP_ROLE) DML on every table and sequence, read access to the
//    drizzle journal (so an api that checks migrations at boot sees "up to date"), then revokes
//    UPDATE / DELETE / TRUNCATE on audit_entry and audit_checkpoint again (append-only, section 4.2).
// Exit code 0 on success, 1 on failure.
import { createRequire } from 'node:module';

const url = process.env.MIGRATE_DATABASE_URL || process.env.DATABASE_URL || '';
const appRole = (process.env.DB_APP_ROLE || '').trim();
const ROLE_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

async function main() {
  const dbmod = await import('@indiansassist/db');
  const db = await dbmod.createDb({ databaseUrl: url, pgliteDir: process.env.PGLITE_DIR });
  try {
    await dbmod.migrate(db, { appRole: null });
    console.log('migrate: migrations applied');
  } finally {
    await dbmod.closeDb(db);
  }
  if (!/^postgres(ql)?:\/\//i.test(url) || appRole === '') return;
  if (!ROLE_RE.test(appRole)) throw new Error('DB_APP_ROLE is not a valid role name');

  // `pg` is a dependency of @indiansassist/db; resolve it from there.
  const req = createRequire(import.meta.resolve('@indiansassist/db'));
  const pg = req('pg');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const role = `"${appRole}"`;
  try {
    await client.query('BEGIN');
    await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
    await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
    const drizzleSchema = await client.query(`SELECT 1 FROM pg_namespace WHERE nspname = 'drizzle'`);
    if (drizzleSchema.rowCount > 0) {
      await client.query(`GRANT USAGE ON SCHEMA drizzle TO ${role}`);
      await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA drizzle TO ${role}`);
    }
    await client.query(`REVOKE UPDATE, DELETE, TRUNCATE ON audit_entry, audit_checkpoint FROM ${role}`);
    const owned = await client.query(
      `SELECT count(*)::int AS n FROM pg_tables WHERE tableowner = $1`,
      [appRole],
    );
    if (owned.rows[0].n > 0) throw new Error(`${appRole} owns tables; DB_APP_ROLE must not own any table`);
    await client.query('COMMIT');
    console.log(`migrate: privileges set for ${appRole} (audit tables append-only)`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('migrate: failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
