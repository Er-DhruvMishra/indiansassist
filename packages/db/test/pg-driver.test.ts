/**
 * node-postgres driver smoke test. Runs only when TEST_DATABASE_URL points at a disposable Postgres database
 * (there is no Postgres on the Phase A build box, so it is skipped there; CI with a postgres service runs it).
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeDb,
  createDb,
  createOrgWithAdmin,
  driverOf,
  insertAuditEntry,
  migrate,
  verifyOrgChain,
  type Db,
} from '../src/index.js';
import { rejectionText } from './helpers.js';

const url = process.env['TEST_DATABASE_URL'] ?? '';

describe.skipIf(url === '')('pg driver', () => {
  let db: Db;
  beforeAll(async () => {
    db = await createDb({ databaseUrl: url });
    await migrate(db, { appRole: null });
  });
  afterAll(async () => {
    await closeDb(db);
  });

  it('migrates, chains 20 concurrent appends under the advisory lock and blocks updates', async () => {
    expect(driverOf(db)).toBe('pg');
    const s = await createOrgWithAdmin(db);
    const rows = await Promise.all(
      Array.from({ length: 20 }, () =>
        insertAuditEntry(db, {
          orgId: s.org.id,
          actor: { type: 'user', id: s.user.id, label: s.user.name },
          action: 'auth.login',
          region: s.org.dataRegion,
          data: { method: 'local' },
        }),
      ),
    );
    expect(new Set(rows.map((r) => r.seq)).size).toBe(20);
    expect(await verifyOrgChain(db, s.org.id)).toMatchObject({ ok: true, checked: 20 });
    expect(await rejectionText(db.execute(sql`update audit_entry set reason = 'x' where id = ${rows[0]!.id}`))).toMatch(
      /append-only/,
    );
  });
});
