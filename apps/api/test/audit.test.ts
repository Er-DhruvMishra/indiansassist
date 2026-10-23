import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseAuditJsonl, verifyAuditJsonl, GENESIS_HASH } from '@indiansassist/shared';
import { getOrgChainTail, getOrg, getUser, pgliteClientOf, seedSession, seedToken, listAuditByOrgPaginated } from '@indiansassist/db';
import { Sweeper } from '../src/sweeper.js';
import { addMember, call, createToken, makeApp, signup, type Account, type TestApp } from './helpers.js';

let t: TestApp;
let admin: Account;

beforeAll(async () => {
  t = await makeApp();
  admin = await signup(t.app);
  await createToken(t.app, admin);
  await createToken(t.app, admin, { tier: 'p1_browser', typ: 'timed' });
});
afterAll(async () => {
  await t.close();
});

describe('audit export, verify and checkpoints', () => {
  it('exports JSONL with a header that verifies offline, anchored by an export checkpoint', async () => {
    const res = await call(t.app, '/api/v1/audit/export', { cookie: admin.cookie, body: {} });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/x-ndjson/);
    expect(res.headers['content-disposition']).toMatch(new RegExp(`^attachment; filename="audit-${admin.org.slug}-\\d{8}\\.jsonl"$`));
    const text = res.body;
    expect(text.endsWith('\n')).toBe(true);
    const parsed = parseAuditJsonl(text);
    if (!parsed.ok) throw new Error(parsed.message);
    expect(parsed.header).toMatchObject({ ia_audit_export: 1, orgId: admin.org.id, region: 'in-mum', startSeq: 1, startPrevHash: GENESIS_HASH });
    expect(parsed.header.keys[0]?.kid).toBe(t.ctx.keys.kid);
    expect(parsed.entries.map((e) => e.action)).toEqual(['auth.signup', 'token.created', 'token.created', 'audit.anchored']);
    const v = verifyAuditJsonl(text);
    expect(v).toMatchObject({ ok: true, checked: 4, countMatches: true });
    const after = await listAuditByOrgPaginated(t.db, admin.org.id, { limit: 1 });
    expect(after.items[0]).toMatchObject({ action: 'audit.exported', data: { format: 'jsonl', count: 4, fromSeq: 1, toSeq: 4 } });
  });

  it('a filtered export verifies as a segment', async () => {
    const all = await listAuditByOrgPaginated(t.db, admin.org.id, { limit: 200 });
    const third = all.items.find((e) => e.seq === 3)!;
    const res = await call(t.app, '/api/v1/audit/export', { cookie: admin.cookie, body: { from: new Date(third.ts).toISOString() } });
    const parsed = parseAuditJsonl(res.body);
    if (!parsed.ok) throw new Error(parsed.message);
    expect(parsed.header.startSeq).toBeGreaterThanOrEqual(2);
    expect(parsed.header.startSeq).toBeLessThanOrEqual(3);
    expect(verifyAuditJsonl(res.body).ok).toBe(true);
  });

  it('verify runs over the whole chain, persists a verify checkpoint and audits audit.verified', async () => {
    expect((await call(t.app, '/api/v1/audit/verify', { cookie: admin.cookie })).body).toBe('null');
    const tailBefore = await getOrgChainTail(t.db, admin.org.id);
    const res = await call(t.app, '/api/v1/audit/verify', { cookie: admin.cookie, method: 'POST' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, checked: tailBefore!.seq, tail: tailBefore!.hash });
    const last = await call(t.app, '/api/v1/audit/verify', { cookie: admin.cookie });
    expect(last.json()).toMatchObject({ ok: true, checked: tailBefore!.seq, verifiedAt: res.json().verifiedAt });
    const top = await listAuditByOrgPaginated(t.db, admin.org.id, { limit: 2 });
    expect(top.items.map((e) => e.action)).toEqual(['audit.verified', 'audit.anchored']);
    const residency = (await call(t.app, '/api/v1/orgs/current/residency', { cookie: admin.cookie })).json();
    const tail = await getOrgChainTail(t.db, admin.org.id);
    expect(residency.chain).toMatchObject({ length: tail!.seq, tail: tail!.hash, lastVerifiedOk: true });
    expect(residency.chain.lastAnchor).toMatchObject({ kid: t.ctx.keys.kid });
    expect(residency.counts).toMatchObject({ users: 1, tokens: 2, sessions: 0, recordings: 0, auditEntries: tail!.seq });
    expect(residency.storage.prefix).toBe(`in-mum/${admin.org.id}/`);
    expect(residency.ice.thirdPartyHosts).toEqual([]);
    expect(residency.statement).toContain('India (Mumbai)');
  });

  it('the database refuses UPDATE on audit_entry, and a rewritten entry is detected', async () => {
    const other = await signup(t.app);
    await createToken(t.app, other);
    const pg = pgliteClientOf(t.db)!;
    await expect(pg.query(`update audit_entry set reason = 'x' where org_id = '${other.org.id}'`)).rejects.toThrow(/append-only/);
    await pg.exec('ALTER TABLE audit_entry DISABLE TRIGGER audit_entry_immutable');
    await pg.query(`update audit_entry set data = '{"tokenId":"x","tier":"p1_browser","typ":"timed","expiresAt":"x"}'::jsonb where org_id = '${other.org.id}' and seq = 2`);
    await pg.exec('ALTER TABLE audit_entry ENABLE TRIGGER audit_entry_immutable');
    const res = await call(t.app, '/api/v1/audit/verify', { cookie: other.cookie, method: 'POST' });
    expect(res.json()).toMatchObject({ ok: false, checked: 1, failure: { kind: 'hash_mismatch', seq: 2 } });
    const persisted = await call(t.app, '/api/v1/audit/verify', { cookie: other.cookie });
    expect(persisted.json()).toMatchObject({ ok: false, failure: { kind: 'hash_mismatch', seq: 2 } });
  });

  it('session audit lists entries with integrity; observers are refused', async () => {
    const org = (await getOrg(t.db, admin.org.id))!;
    const user = (await getUser(t.db, admin.user.id))!;
    const tok = await seedToken(t.db, org, user);
    const s = await seedSession(t.db, tok);
    const res = await call(t.app, `/api/v1/sessions/${s.id}/audit`, { cookie: admin.cookie });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ items: [], integrity: { ok: true, checked: 0 }, files: [] });
    const observer = await addMember(t.app, admin, 'observer');
    expect((await call(t.app, `/api/v1/sessions/${s.id}/audit`, { cookie: observer.cookie })).statusCode).toBe(403);
    expect((await call(t.app, `/api/v1/sessions/${s.id}`, { cookie: observer.cookie })).statusCode).toBe(200);
    const list = await call(t.app, '/api/v1/audit?action=token.created&limit=1', { cookie: admin.cookie });
    expect(list.json().items).toHaveLength(1);
    expect(list.json().nextCursor).toEqual(expect.any(String));
  });

  it('the sweeper writes periodic checkpoints only for orgs whose tail is not an anchor', async () => {
    const fresh = await signup(t.app);
    const sweeper = new Sweeper(t.ctx);
    const n = await sweeper.periodicCheckpoints();
    expect(n).toBeGreaterThanOrEqual(1);
    const top = await listAuditByOrgPaginated(t.db, fresh.org.id, { limit: 1 });
    expect(top.items[0]?.action).toBe('audit.anchored');
    expect(await sweeper.periodicCheckpoints()).toBe(0);
  });
});
