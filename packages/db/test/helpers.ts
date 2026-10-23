import { closeDb, createDb, migrate, type Db } from '../src/index.js';

/** Fresh in-memory PGlite with every migration applied. */
export async function freshDb(): Promise<Db> {
  const db = await createDb({ databaseUrl: 'memory://' });
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
