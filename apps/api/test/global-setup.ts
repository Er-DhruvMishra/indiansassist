/**
 * Vitest global setup: one migrated PGlite data directory per run, dumped to a temp tarball that every test
 * database starts from (`makeDb`). Each test file still gets its own in-memory instance; only initdb and the
 * migrations, about 4 s of CPU and 250 MB of heap per database, are paid once instead of once per file.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, createDb, migrate, pgliteClientOf } from '@indiansassist/db';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Path of the migrated PGlite `dumpDataDir()` tarball, or '' when the template could not be built. */
    pgliteTemplate: string;
  }
}

export default async function setup(project: TestProject): Promise<() => void> {
  const dir = mkdtempSync(join(tmpdir(), 'ia-api-pglite-'));
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
