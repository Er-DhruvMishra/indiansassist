import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkToken, publicKeyFromBase64url, signToken, type WellKnown } from '@indiansassist/shared';
import { listAuditByOrgPaginated } from '@indiansassist/db';
import { addMember, call, createToken, makeApp, signup, TURN_SECRET, type Account, type TestApp } from './helpers.js';

let t: TestApp;
let admin: Account;

beforeAll(async () => {
  t = await makeApp();
  admin = await signup(t.app);
  await call(t.app, '/api/v1/orgs/current/branding', { method: 'PATCH', cookie: admin.cookie, body: { displayName: 'Acme IT' } });
});
afterAll(async () => {
  await t.close();
});

const lookup = (code: string) => call(t.app, '/api/v1/tokens/public-lookup', { body: { code } });

describe('tokens', () => {
  it('creates an Ed25519 token that verifies with the well-known key and audits token.created', async () => {
    const created = await createToken(t.app, admin, { tier: 'p1_browser', typ: 'one_time', label: 'Printer‮ issue' });
    expect(created.compact).toMatch(/^ia1\.[0-9a-f]{16}\./);
    expect(created.joinUrl).toBe(`http://localhost:5173/join#t=${created.compact}`);
    expect(created.token).toMatchObject({ status: 'active', label: 'Printer issue', region: 'in-mum', joinHost: 'localhost:5173' });
    expect(created.token.shortCode).toMatch(/^[1-9]\d{11}$/);
    const wk = (await call(t.app, '/.well-known/indiansassist.json')).json() as WellKnown;
    const keys = wk.keys.map((k) => ({ kid: k.kid, pub: publicKeyFromBase64url(k.pub) }));
    const check = await checkToken(created.compact, keys);
    expect(check.ok).toBe(true);
    // The Token object's joinUrl rebuilds the same compact string from the row.
    const got = await call(t.app, `/api/v1/tokens/${created.token.id}`, { cookie: admin.cookie });
    expect(got.json().joinUrl).toBe(created.joinUrl);
    const exp = (Date.parse(got.json().expiresAt) - Date.parse(got.json().issuedAt)) / 60000;
    expect(exp).toBe(15);
    const audit = await listAuditByOrgPaginated(t.db, admin.org.id, { action: 'token.created' });
    expect(audit.items[0]?.data).toMatchObject({ tokenId: created.token.id, tier: 'p1_browser', typ: 'one_time' });
    expect(JSON.stringify(audit.items[0]?.data)).not.toContain(created.token.shortCode);
  });

  it('validates type, lifetime and seat tier', async () => {
    const enr = await call(t.app, '/api/v1/tokens', { cookie: admin.cookie, body: { tier: 'p1_browser', typ: 'enrollment' } });
    expect(enr.json().error.code).toBe('invalid_token_type');
    const tooLong = await call(t.app, '/api/v1/tokens', { cookie: admin.cookie, body: { tier: 'p1_browser', typ: 'one_time', ttlMinutes: 61 } });
    expect(tooLong.json().error.code).toBe('validation_failed');
    const wrongField = await call(t.app, '/api/v1/tokens', { cookie: admin.cookie, body: { tier: 'p1_browser', typ: 'timed', ttlDays: 1 } });
    expect(wrongField.json().error.code).toBe('validation_failed');
    const overSeat = await call(t.app, '/api/v1/tokens', { cookie: admin.cookie, body: { tier: 'p2_extension', typ: 'timed' } });
    expect(overSeat.statusCode).toBe(400);
    expect(overSeat.json().error.code).toBe('tier_not_licensed');
    const timed = await createToken(t.app, admin, { tier: 'p1_browser', typ: 'timed', ttlMinutes: 480 });
    const tg = (await call(t.app, `/api/v1/tokens/${timed.token.id}`, { cookie: admin.cookie })).json();
    expect((Date.parse(tg.expiresAt) - Date.parse(tg.issuedAt)) / 60000).toBe(480);
  });

  it('public lookup by compact token discloses the technician; by short code it does not', async () => {
    const tech = await addMember(t.app, admin, 'technician', 'Rahul T');
    const created = await createToken(t.app, tech);
    const byCompact = await lookup(created.compact);
    expect(byCompact.statusCode).toBe(200);
    expect(byCompact.json()).toMatchObject({
      tokenId: created.token.id,
      tier: 'p1_browser',
      typ: 'one_time',
      region: 'in-mum',
      technician: { name: 'Rahul T' },
      org: { displayName: 'Acme IT', logoData: null, supportEmail: null },
      signalUrl: 'ws://localhost:4000/signal',
      joinSupported: true,
    });
    expect(JSON.stringify(byCompact.json())).not.toContain(created.token.shortCode);
    const spaced = `${created.token.shortCode.slice(0, 4)} ${created.token.shortCode.slice(4, 8)} ${created.token.shortCode.slice(8)}`;
    const byCode = await lookup(spaced);
    expect(byCode.statusCode).toBe(200);
    expect(byCode.json().technician).toBeNull();
    expect(byCode.json().tokenId).toBe(created.token.id);
  });

  it('answers malformed, bad signature and not found per section 3.5', async () => {
    const created = await createToken(t.app, admin);
    expect((await lookup('hello')).json().error.code).toBe('token_malformed');
    expect((await lookup('ia1.zz.x.y')).json().error.code).toBe('token_malformed');
    const parts = created.compact.split('.');
    const sig = parts[3]!;
    const flipped = `${parts.slice(0, 3).join('.')}.${(sig[0] === 'A' ? 'B' : 'A') + sig.slice(1)}`;
    const bad = await lookup(flipped);
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('token_bad_signature');
    // A validly signed token whose row does not exist.
    const forged = await signToken(
      { tid: '00000000-0000-4000-8000-000000000000', org: admin.org.id, by: admin.user.id, tier: 'p1_browser', typ: 'one_time', reg: 'in-mum', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600 },
      t.ctx.keys.seedHex,
    );
    expect((await lookup(forged.compact)).statusCode).toBe(404);
    expect((await lookup('999999999999')).json().error.code).toBe('token_not_found');
    const expired = await signToken(
      { tid: created.token.id, org: admin.org.id, by: admin.user.id, tier: 'p1_browser', typ: 'one_time', reg: 'in-mum', iat: 1000, exp: 2000 },
      t.ctx.keys.seedHex,
    );
    const gone = await lookup(expired.compact);
    expect(gone.statusCode).toBe(410);
    expect(gone.json().error.details.status).toBe('expired');
  });

  it('revoke is idempotent, audited once, and the public lookup then answers 410 / 404', async () => {
    const created = await createToken(t.app, admin);
    const r1 = await call(t.app, `/api/v1/tokens/${created.token.id}/revoke`, { cookie: admin.cookie, method: 'POST' });
    expect(r1.statusCode).toBe(200);
    expect(r1.json().status).toBe('revoked');
    expect(r1.json().revokedAt).not.toBeNull();
    const r2 = await call(t.app, `/api/v1/tokens/${created.token.id}/revoke`, { cookie: admin.cookie, method: 'POST' });
    expect(r2.statusCode).toBe(200);
    const audit = await listAuditByOrgPaginated(t.db, admin.org.id, { action: 'token.revoked' });
    expect(audit.items.filter((e) => (e.data as { tokenId: string }).tokenId === created.token.id)).toHaveLength(1);
    expect(audit.items[0]?.data).toMatchObject({ reason: 'manual' });
    const gone = await lookup(created.compact);
    expect(gone.statusCode).toBe(410);
    expect(gone.json().error).toMatchObject({ code: 'token_gone', details: { status: 'revoked' } });
    expect((await lookup(created.token.shortCode)).statusCode).toBe(404);
    const active = (await call(t.app, '/api/v1/tokens?status=active', { cookie: admin.cookie })).json();
    expect(active.items.some((x: { id: string }) => x.id === created.token.id)).toBe(false);
    const revoked = (await call(t.app, '/api/v1/tokens?status=revoked', { cookie: admin.cookie })).json();
    expect(revoked.items.some((x: { id: string }) => x.id === created.token.id)).toBe(true);
  });

  it('paginates tokens with an opaque cursor', async () => {
    const other = await signup(t.app);
    for (let i = 0; i < 3; i++) await createToken(t.app, other);
    const p1 = (await call(t.app, '/api/v1/tokens?limit=2', { cookie: other.cookie })).json();
    expect(p1.items).toHaveLength(2);
    expect(p1.nextCursor).toEqual(expect.any(String));
    const p2 = (await call(t.app, `/api/v1/tokens?limit=2&cursor=${p1.nextCursor}`, { cookie: other.cookie })).json();
    expect(p2.items).toHaveLength(1);
    expect(p2.nextCursor).toBeNull();
    expect((await call(t.app, '/api/v1/tokens?cursor=***', { cookie: other.cookie })).statusCode).toBe(400);
  });
});

describe('ICE (section 6.11)', () => {
  it('returns STUN plus TURN REST credentials whose HMAC-SHA1 checks out', async () => {
    const res = await call(t.app, '/api/v1/ice', { cookie: admin.cookie });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.iceTtl).toBe(3600);
    expect(body.iceServers[0]).toEqual({ urls: ['stun:turn.example.test:3478'] });
    const turn = body.iceServers[1];
    expect(turn.urls).toEqual(['turn:turn.example.test:3478?transport=udp', 'turns:turn.example.test:5349']);
    const [expiry, ...principal] = String(turn.username).split(':');
    expect(principal.join(':')).toBe(`user:${admin.user.id}`);
    const nowSec = Math.floor(Date.now() / 1000);
    expect(Number(expiry)).toBeGreaterThanOrEqual(nowSec + 3590);
    expect(Number(expiry)).toBeLessThanOrEqual(nowSec + 3600);
    const expected = createHmac('sha1', TURN_SECRET).update(turn.username).digest('base64');
    expect(turn.credential).toBe(expected);
    expect(Date.parse(body.iceExpiresAt)).toBe(Number(expiry) * 1000);
  });

  it('is refused for auditors and for a session the caller is not the assist of', async () => {
    const auditor = await addMember(t.app, admin, 'auditor');
    expect((await call(t.app, '/api/v1/ice', { cookie: auditor.cookie })).statusCode).toBe(403);
    expect((await call(t.app, '/api/v1/ice?sessionId=00000000-0000-4000-8000-000000000000', { cookie: admin.cookie })).statusCode).toBe(404);
  });
});
