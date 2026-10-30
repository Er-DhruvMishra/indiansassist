import { readFileSync } from 'node:fs';
import { inject } from 'vitest';
import { closeDb, createDb, migrate, type Db } from '../src/index.js';

let template: Blob | null | undefined;

/**
 * Fresh in-memory PGlite with every migration applied, started from the run's migrated template
 * (test/global-setup.ts) when there is one; `migrate` then only confirms the journal.
 */
export async function freshDb(): Promise<Db> {
  if (template === undefined) {
    const file = inject('pgliteTemplate');
    template = file ? new Blob([readFileSync(file)]) : null;
  }
  const db = await createDb({ databaseUrl: 'memory://', ...(template ? { pgliteLoadDataDir: template } : {}) });
  await migrate(db);
  return db;
}

export { closeDb };

/** Message of an error and of every `cause` below it (drizzle wraps driver errors). */
export function errorText(err: unknown): string {
  const parts: string[] = [];
  let e: unknown = err;
  for (let i = 0; i < 5 && e; i++) {
    if (e instanceof Error) {
      parts.push(e.message);
      e = (e as { cause?: unknown }).cause;
    } else {
      parts.push(String(e));
      break;
    }
  }
  return parts.join(' | ');
}

/** Resolves to the rejection's error text; fails the test if the promise resolves. */
export async function rejectionText(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return errorText(err);
  }
  throw new Error('expected promise to reject');
}
