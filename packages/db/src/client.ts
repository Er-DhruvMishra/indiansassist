/**
 * Database factory (contracts section 4.3). One `Db` type for both drivers:
 * - PGlite (`@electric-sql/pglite`, embedded Postgres) for dev and tests;
 * - node-postgres (`pg` Pool) for real Postgres.
 *
 * URL rules (superset of section 4.3, also accepting the `pglite://` form):
 *   ''                      -> PGlite persisted at `pgliteDir` (in-memory when `pgliteDir` is not given)
 *   'memory://'             -> in-memory PGlite
 *   'pglite://' | 'pglite://memory' -> in-memory PGlite
 *   'pglite://<dir>'        -> PGlite persisted at <dir>
 *   'postgres://...' / 'postgresql://...' -> pg Pool
 */
import { mkdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import type { ExtractTablesWithRelations, SQL } from 'drizzle-orm';
import { drizzle as drizzleNodePg } from 'drizzle-orm/node-postgres';
import type { PgDatabase, PgQueryResultHKT, PgTransaction } from 'drizzle-orm/pg-core';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import pg from 'pg';
import { schema, type Schema } from './schema/index.js';

export type Db = PgDatabase<PgQueryResultHKT, Schema>;
export type Tx = PgTransaction<PgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>>;
/** Anything a repository function can run on: the database or an open transaction. */
export type Executor = Db | Tx;

export type DriverKind = 'pglite' | 'pg';

type Handle = { kind: 'pglite'; client: PGlite; dataDir: string | null } | { kind: 'pg'; client: pg.Pool };

const handles = new WeakMap<object, Handle>();

export type CreateDbOptions = {
  /** Section 4.3 name (env `DATABASE_URL`). */
  databaseUrl?: string;
  /** Alias of `databaseUrl`. */
  url?: string;
  /** Env `PGLITE_DIR`; used when the URL is empty. */
  pgliteDir?: string;
  /** pg Pool size (pg driver only). */
  poolMax?: number;
  /**
   * PGlite only: start from a `dumpDataDir()` tarball instead of running initdb. Tests load one migrated template
   * per run, which skips about 4 s of CPU and 250 MB of heap per database.
   */
  pgliteLoadDataDir?: Blob;
};

export type ResolvedTarget = { kind: 'pglite'; dataDir: string | null } | { kind: 'pg'; connectionString: string };

/** Pure URL -> driver resolution (exported for tests and for the API's config logging). */
export function resolveDbTarget(opts: CreateDbOptions): ResolvedTarget {
  const url = (opts.databaseUrl ?? opts.url ?? '').trim();
  if (url === '') return { kind: 'pglite', dataDir: opts.pgliteDir?.trim() ? opts.pgliteDir.trim() : null };
  if (url === 'memory://') return { kind: 'pglite', dataDir: null };
  if (url.startsWith('pglite://')) {
    const rest = url.slice('pglite://'.length);
    return { kind: 'pglite', dataDir: rest === '' || rest === 'memory' ? null : rest };
  }
  if (/^postgres(ql)?:\/\//i.test(url)) return { kind: 'pg', connectionString: url };
  throw new Error(`unsupported database URL scheme (expected '', memory://, pglite:// or postgres://)`);
}

export async function createDb(opts: CreateDbOptions = {}): Promise<Db> {
  const target = resolveDbTarget(opts);
  if (target.kind === 'pglite') {
    if (target.dataDir) mkdirSync(target.dataDir, { recursive: true });
    const extra = opts.pgliteLoadDataDir ? { loadDataDir: opts.pgliteLoadDataDir } : {};
    const client = target.dataDir ? new PGlite(target.dataDir, extra) : new PGlite(extra);
    await client.waitReady;
    const db = drizzlePglite({ client, schema });
    handles.set(db, { kind: 'pglite', client, dataDir: target.dataDir });
    return db as unknown as Db;
  }
  const pool = new pg.Pool({ connectionString: target.connectionString, max: opts.poolMax ?? 10 });
  const db = drizzleNodePg({ client: pool, schema });
  handles.set(db, { kind: 'pg', client: pool });
  return db as unknown as Db;
}

function handleOf(db: Db): Handle {
  const h = handles.get(db);
  if (!h) throw new Error('not a database created by createDb()');
  return h;
}

export function driverOf(db: Db): DriverKind {
  return handleOf(db).kind;
}

/** The underlying PGlite instance (tests use it for raw SQL), or null on the pg driver. */
export function pgliteClientOf(db: Db): PGlite | null {
  const h = handleOf(db);
  return h.kind === 'pglite' ? h.client : null;
}

export async function closeDb(db: Db): Promise<void> {
  const h = handles.get(db);
  if (!h) return;
  handles.delete(db);
  if (h.kind === 'pglite') {
    if (!h.client.closed) await h.client.close();
  } else {
    await h.client.end();
  }
}

/**
 * Raw SQL helper returning typed rows on either driver (`Db.execute` is typed `unknown` for the generic
 * PgQueryResultHKT; node-postgres and PGlite both return `{ rows }`).
 */
export async function queryRows<T extends Record<string, unknown>>(exec: Executor, query: SQL): Promise<T[]> {
  const res = (await exec.execute(query)) as unknown as { rows: T[] };
  return res.rows;
}
