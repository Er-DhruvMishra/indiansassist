/**
 * Vitest global setup: one migrated PGlite data directory per run, dumped to a temp tarball that `freshDb` starts
 * from. Each database is still its own in-memory instance; initdb and the migrations (about 4 s of CPU and 250 MB
 * of heap each) are paid once per run instead of once per database.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';
import { closeDb, createDb, migrate, pgliteClientOf } from '../src/index.js';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Path of the migrated PGlite `dumpDataDir()` tarball. */
    pgliteTemplate: string;
  }
}

export default async function setup(project: TestProject): Promise<() => void> {
  const dir = mkdtempSync(join(tmpdir(), 'ia-db-pglite-'));
  const file = join(dir, 'migrated.tar');
  const db = await createDb({ databaseUrl: 'memory://' });
  try {
    await migrate(db);
    const blob = await pgliteClientOf(db)!.dumpDataDir('none');
    writeFileSync(file, Buffer.from(await blob.arrayBuffer()));
  } finally {
    await closeDb(db);
  }
  project.provide('pgliteTemplate', file);
  return () => rmSync(dir, { recursive: true, force: true });
}
