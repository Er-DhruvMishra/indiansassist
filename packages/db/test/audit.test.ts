import {
  GENESIS_HASH,
  hashAuditEntry,
  kidOf,
  publicKeyFromSeed,
  signCheckpoint,
  verifyChain,
} from '@indiansassist/shared';
import { sql } from 'drizzle-orm';
import { ZodError } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appendAudit,
  queryRows,
  AuditRegionMismatchError,
  createOrgWithAdmin,
  getOrgChainTail,
  getSession,
  insertAuditCheckpoint,
  insertAuditEntry,
  listAuditByOrgPaginated,
  listAuditBySession,
  seedSession,
  seedToken,
  setCheckpointAnchor,
  toChainEntry,
  verifyOrgChain,
  type Db,
  type SeededOrg,
} from '../src/index.js';
import { closeDb, freshDb, rejectionText } from './helpers.js';

const SEED = '11'.repeat(32);

function login(db: Db, s: SeededOrg, i = 0) {
  return insertAuditEntry(db, {
    orgId: s.org.id,
    actor: { type: 'user', id: s.user.id, label: s.user.name },
    action: 'auth.login',
    region: s.org.dataRegion,
    data: { method: 'local' },
    ts: new Date(Date.UTC(2026, 9, 23, 10, 0, 0, i)),
  });
}

describe('audit_entry', () => {
  let db: Db;
  let a: SeededOrg;
  beforeAll(async () => {
    db = await freshDb();
    a = await createOrgWithAdmin(db, { withSignupAudit: true });
  });
  afterAll(async () => {
    await closeDb(db);
  });

  it('starts at seq 1 from the genesis hash and round-trips row -> material -> hash', async () => {
    const rows = await listAuditByOrgPaginated(db, a.org.id);
    const first = rows.items[rows.items.length - 1]!;
    expect(first.seq).toBe(1);
    expect(first.prevHash).toBe(GENESIS_HASH);
    expect(first.action).toBe('auth.signup');
    const tok = await seedToken(db, a.org, a.user);
    const sess = await seedSession(db, tok);
    // every data type: string, integer, boolean, null, nested object, array
    const row = await insertAuditEntry(db, {
      orgId: a.org.id,
      sessionId: sess.id,
      actor: { type: 'user', id: a.user.id, label: 'Priya​ S\u0007' },
      action: 'audit.verified',
      reason: 'line\u0000one',
      region: a.org.dataRegion,
      data: { ok: false, checked: 12, failure: { kind: 'seq_gap', seq: 3 } },
      ts: new Date('2026-10-23T10:15:30.123Z'),
    });
    expect(row.actorLabel).toBe('Priya S');
    expect(row.reason).toBe('lineone');
    const entry = toChainEntry(row);
    expect(entry.ts).toBe('2026-10-23T10:15:30.123Z');
    expect(hashAuditEntry(entry)).toBe(row.hash);
    const names = await insertAuditEntry(db, {
      orgId: a.org.id,
      actor: { type: 'user', id: a.user.id, label: a.user.name },
      action: 'org.branding_updated',
      region: a.org.dataRegion,
      data: { fields: ['displayName', 'accentColor'] },
    });
    expect(hashAuditEntry(toChainEntry(names))).toBe(names.hash);
    expect((await getSession(db, sess.id))?.hashChainTail).toBe(row.hash);
    expect((await listAuditBySession(db, sess.id)).map((r) => r.id)).toEqual([row.id]);
  });

  it('truncates ts to whole milliseconds', async () => {
    const row = await insertAuditEntry(db, {
      orgId: a.org.id,
      actor: { type: 'system', id: null, label: 'system' },
      action: 'auth.logout',
      region: a.org.dataRegion,
      ts: new Date(1_792_700_000_123.9),
    });
    expect(row.ts.toISOString()).toBe(new Date(1_792_700_000_123).toISOString());
    expect(hashAuditEntry(toChainEntry(row))).toBe(row.hash);
  });

  it('rejects a region that differs from org.data_region and invalid data before writing', async () => {
    const before = await getOrgChainTail(db, a.org.id);
    await expect(
      insertAuditEntry(db, {
        orgId: a.org.id,
        actor: { type: 'system', id: null, label: 'system' },
        action: 'auth.logout',
        region: 'eu-fra',
      }),
    ).rejects.toBeInstanceOf(AuditRegionMismatchError);
    await expect(
      insertAuditEntry(db, {
        orgId: a.org.id,
        actor: { type: 'system', id: null, label: 'system' },
        action: 'auth.login',
        region: a.org.dataRegion,
        data: { method: 'magic' },
      }),
    ).rejects.toBeInstanceOf(ZodError);
    expect(await getOrgChainTail(db, a.org.id)).toEqual(before);
  });

  it('append-only trigger blocks UPDATE, DELETE and TRUNCATE', async () => {
    const row = await login(db, a);
    expect(await rejectionText(db.execute(sql`update audit_entry set reason = 'x' where id = ${row.id}`))).toMatch(
      /audit_entry is append-only/,
    );
    expect(await rejectionText(db.execute(sql`delete from audit_entry where id = ${row.id}`))).toMatch(
      /audit_entry is append-only/,
    );
    expect(await rejectionText(db.execute(sql`truncate audit_entry cascade`))).toMatch(/append-only/);
    const rows = await queryRows<{ n: number }>(
      db,
      sql`select count(*)::int as n from audit_entry where id = ${row.id}`,
    );
    expect(rows[0]!.n).toBe(1);
  });

  it('serialises 20 concurrent appends into one unbroken chain', async () => {
    const b = await createOrgWithAdmin(db);
    const rows = await Promise.all(Array.from({ length: 20 }, (_, i) => login(db, b, i)));
    expect(new Set(rows.map((r) => r.seq)).size).toBe(20);
    const sorted = [...rows].sort((x, y) => x.seq - y.seq);
    expect(sorted.map((r) => r.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(sorted[0]!.prevHash).toBe(GENESIS_HASH);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i]!.prevHash).toBe(sorted[i - 1]!.hash);
    expect(verifyChain(sorted.map(toChainEntry), { orgId: b.org.id, region: b.org.dataRegion })).toEqual({
      ok: true,
      checked: 20,
      tail: sorted[19]!.hash,
    });
    expect(await verifyOrgChain(db, b.org.id)).toEqual({ ok: true, checked: 20, tail: sorted[19]!.hash });
  });

  it('serialises concurrent appends issued from inside open transactions (appendAudit on a tx)', async () => {
    const c = await createOrgWithAdmin(db);
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        db.transaction(async (tx) =>
          appendAudit(tx, {
            orgId: c.org.id,
            actor: { type: 'user', id: c.user.id, label: c.user.name },
            action: 'auth.login',
            region: c.org.dataRegion,
            data: { method: i % 2 ? 'local' : 'invite' },
          }),
        ),
      ),
    );
    expect(await verifyOrgChain(db, c.org.id)).toMatchObject({ ok: true, checked: 10 });
  });

  it('keeps independent chains per org', async () => {
    const res = await verifyOrgChain(db, a.org.id);
    expect(res.ok).toBe(true);
    expect(res.checked).toBe((await getOrgChainTail(db, a.org.id))!.seq);
  });
});

describe('verifyOrgChain', () => {
  let db: Db;
  beforeAll(async () => {
    db = await freshDb();
  });
  afterAll(async () => {
    await closeDb(db);
  });

  async function chainOf(n: number): Promise<SeededOrg> {
    const s = await createOrgWithAdmin(db);
    for (let i = 0; i < n; i++) await login(db, s, i);
    return s;
  }

  it('detects a row tampered with raw SQL once the trigger is disabled', async () => {
    const s = await chainOf(6);
    expect(await verifyOrgChain(db, s.org.id, { batchSize: 4 })).toMatchObject({ ok: true, checked: 6 });

    await db.execute(sql`alter table audit_entry disable trigger audit_entry_immutable`);
    try {
      await db.execute(
        sql`update audit_entry set data = '{"method":"invite"}'::jsonb where org_id = ${s.org.id} and seq = 3`,
      );
    } finally {
      await db.execute(sql`alter table audit_entry enable trigger audit_entry_immutable`);
    }
    const res = await verifyOrgChain(db, s.org.id, { batchSize: 4 });
    expect(res.ok).toBe(false);
    expect(res.failure).toEqual({ kind: 'hash_mismatch', seq: 3 });
    expect(res.checked).toBe(2);
    // the trigger is active again
    expect(await rejectionText(db.execute(sql`delete from audit_entry where org_id = ${s.org.id}`))).toMatch(
      /append-only/,
    );
  });

  it('detects a deleted row as a seq gap across batch boundaries', async () => {
    const s = await chainOf(5);
    await db.execute(sql`alter table audit_entry disable trigger audit_entry_immutable`);
    try {
      await db.execute(sql`delete from audit_entry where org_id = ${s.org.id} and seq = 3`);
    } finally {
      await db.execute(sql`alter table audit_entry enable trigger audit_entry_immutable`);
    }
    expect(await verifyOrgChain(db, s.org.id, { batchSize: 2 })).toMatchObject({
      ok: false,
      checked: 2,
      failure: { kind: 'seq_gap', seq: 4 },
    });
  });

  it('fails with tail_regression when the chain is shorter than the latest checkpoint', async () => {
    const s = await chainOf(3);
    const tail = (await getOrgChainTail(db, s.org.id))!;
    expect(await verifyOrgChain(db, s.org.id, { checkpoint: { seq: 5, tail: tail.hash } })).toMatchObject({
      ok: false,
      failure: { kind: 'tail_regression', seq: 3 },
    });
    expect(await verifyOrgChain(db, s.org.id, { checkpoint: { seq: 2, tail: 'f'.repeat(64) } })).toMatchObject({
      ok: false,
      failure: { kind: 'tail_regression', seq: 2 },
    });
  });

  it('verifies signed anchors (also across batches) and stores checkpoints append-only', async () => {
    const s = await chainOf(3);
    const pub = await publicKeyFromSeed(SEED);
    const kid = kidOf(pub);
    const tail = (await getOrgChainTail(db, s.org.id))!;
    const ts = new Date('2026-10-23T11:00:00.000Z');
    const sig = await signCheckpoint({ org_id: s.org.id, seq: tail.seq, tail: tail.hash, ts: ts.toISOString() }, SEED);
    const cp = await insertAuditCheckpoint(db, {
      orgId: s.org.id,
      kind: 'periodic',
      seq: tail.seq,
      tail: tail.hash,
      ts,
      kid,
      sig,
    });
    const anchored = await insertAuditEntry(db, {
      orgId: s.org.id,
      actor: { type: 'system', id: null, label: 'system' },
      action: 'audit.anchored',
      region: s.org.dataRegion,
      data: { seq: tail.seq, tail: tail.hash, ts: ts.toISOString(), kid, sig },
    });
    const linked = await setCheckpointAnchor(db, cp.id, anchored.id);
    expect(linked.anchoredEntryId).toBe(anchored.id);
    // the one permitted update happens once; everything else is blocked
    expect(await rejectionText(setCheckpointAnchor(db, cp.id, anchored.id))).toMatch(/audit_checkpoint is append-only/);
    expect(await rejectionText(db.execute(sql`update audit_checkpoint set seq = 1 where id = ${cp.id}`))).toMatch(
      /append-only/,
    );
    expect(await rejectionText(db.execute(sql`delete from audit_checkpoint where id = ${cp.id}`))).toMatch(
      /append-only/,
    );

    const keys = [{ kid, pub }];
    expect(await verifyOrgChain(db, s.org.id, { pubKeys: keys })).toMatchObject({ ok: true, checked: 4 });
    expect(await verifyOrgChain(db, s.org.id, { pubKeys: keys, batchSize: 3 })).toMatchObject({ ok: true, checked: 4 });
    const otherPub = await publicKeyFromSeed('22'.repeat(32));
    expect(await verifyOrgChain(db, s.org.id, { pubKeys: [{ kid, pub: otherPub }] })).toMatchObject({
      ok: false,
      failure: { kind: 'anchor_bad_signature', seq: 4 },
    });
  });

  it('pages the org list by seq descending', async () => {
    const s = await chainOf(5);
    const p1 = await listAuditByOrgPaginated(db, s.org.id, { limit: 2 });
    expect(p1.items.map((r) => r.seq)).toEqual([5, 4]);
    const p2 = await listAuditByOrgPaginated(db, s.org.id, { limit: 2, cursor: p1.nextCursor });
    expect(p2.items.map((r) => r.seq)).toEqual([3, 2]);
    const p3 = await listAuditByOrgPaginated(db, s.org.id, { limit: 2, cursor: p2.nextCursor });
    expect(p3.items.map((r) => r.seq)).toEqual([1]);
    expect(p3.nextCursor).toBeNull();
    const filtered = await listAuditByOrgPaginated(db, s.org.id, { action: 'auth.signup' });
    expect(filtered.items).toEqual([]);
  });
});
