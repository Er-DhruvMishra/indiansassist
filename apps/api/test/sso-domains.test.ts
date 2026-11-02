/**
 * Phase E section 15.2: verified domains (section 3.2) through an injected TXT resolver: proof, public domains,
 * per-region uniqueness, the weekly re-check and `lapsed`, and the route errors and roles.
 */
import { randomBytes } from 'node:crypto';
import { domainToASCII } from 'node:url';
import { LIMITS } from '@indiansassist/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recheckDomains } from '../src/sso/domains.js';
import { sweepSsoDomains } from '../src/sso/sweep.js';
import { call, cookieOf, PASSWORD, signup, type Account, type TestApp } from './helpers.js';
import { auditOf, makeSsoApp, type FakeDns } from './sso-fakes.js';

let t: TestApp & { dns: FakeDns };
let admin: Account;

const dom = () => `d${randomBytes(4).toString('hex')}.test`;

async function add(a: Account, domain: string) {
  return call(t.app, '/api/v1/orgs/current/sso/domains', { cookie: a.cookie, body: { domain } });
}
async function verify(a: Account, id: string) {
  return call(t.app, `/api/v1/orgs/current/sso/domains/${id}/verify`, { cookie: a.cookie, method: 'POST' });
}

beforeAll(async () => {
  t = await makeSsoApp();
  admin = await signup(t.app);
});

afterAll(async () => {
  await t?.close();
});

describe('adding domains', () => {
  it('returns a pending domain with its TXT record; IDNA is normalised', async () => {
    const r = await add(admin, 'Bücher-Example.TEST');
    expect(r.statusCode).toBe(201);
    const d = r.json();
    const ascii = domainToASCII('bücher-example.test');
    expect(ascii.startsWith('xn--')).toBe(true);
    expect(d).toMatchObject({ domain: ascii, status: 'pending', txtName: `_indiansassist.${ascii}`, verifiedAt: null });
    expect(d.txtValue).toMatch(/^ia-verify=[0-9a-f]{32}$/);
    expect((await auditOf(t.app, admin.cookie, 'sso.domain_added'))[0]?.data).toEqual({ domainId: d.id, domain: d.domain });
  });

  it('refuses invalid, public and duplicate domains', async () => {
    for (const bad of ['localhost', '*.acme.test', 'acme', 'acme.123', '-x.test', 'a..b.test', 'http://acme.test/']) {
      const r = await add(admin, bad);
      expect(r.statusCode, bad).toBe(400);
      expect(r.json().error.code, bad).toBe('domain_invalid');
    }
    for (const pub of ['gmail.com', 'Outlook.com', 'rediffmail.com']) {
      const r = await add(admin, pub);
      expect(r.json().error.code, pub).toBe('domain_not_allowed');
    }
    const d = dom();
    expect((await add(admin, d)).statusCode).toBe(201);
    const dup = await add(admin, d.toUpperCase());
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('domain_exists');
  });

  it('caps the list at LIMITS.ssoDomainsMax', async () => {
    const a = await signup(t.app);
    for (let i = 0; i < LIMITS.ssoDomainsMax; i++) expect((await add(a, dom())).statusCode).toBe(201);
    const r = await add(a, dom());
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('domain_limit');
  });
});

describe('verification', () => {
  it('verifies through the injected resolver (character-strings joined) and reports what it found otherwise', async () => {
    const d = (await add(admin, dom())).json();
    t.dns.records.set(d.txtName, [['v=spf1 -all'], ['ia-verify=0000']]);
    const miss = await verify(admin, d.id);
    expect(miss.statusCode).toBe(409);
    expect(miss.json().error.code).toBe('domain_unverified');
    expect(miss.json().error.details.found).toEqual(['v=spf1 -all', 'ia-verify=0000']);
    const token = String(d.txtValue);
    t.dns.records.set(d.txtName, [['v=spf1 -all'], [token.slice(0, 12), token.slice(12)]]);
    const ok = await verify(admin, d.id);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ status: 'verified' });
    expect(ok.json().verifiedAt).toBeTruthy();
    expect((await auditOf(t.app, admin.cookie, 'sso.domain_verified'))[0]?.data).toEqual({ domainId: d.id, domain: d.domain });
  });

  it('a domain verified by one org cannot be verified by another in the region; two may hold it pending', async () => {
    const d = dom();
    const a = await signup(t.app);
    const b = await signup(t.app);
    const da = (await add(a, d)).json();
    const db = (await add(b, d)).json();
    t.dns.set(da.txtName, [da.txtValue, db.txtValue]);
    expect((await verify(a, da.id)).statusCode).toBe(200);
    const taken = await verify(b, db.id);
    expect(taken.statusCode).toBe(409);
    expect(taken.json().error.code).toBe('domain_taken');
  });

  it('unknown and cross-org ids are 404', async () => {
    const other = await signup(t.app);
    const d = (await add(other, dom())).json();
    expect((await verify(admin, d.id)).statusCode).toBe(404);
    expect((await verify(admin, '00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
    expect((await call(t.app, `/api/v1/orgs/current/sso/domains/${d.id}`, { method: 'DELETE', cookie: admin.cookie })).statusCode).toBe(404);
  });
});

describe('the weekly re-check (rule 3.2d)', () => {
  it('three consecutive misses lapse a domain and chain sso.domain_lapsed; a hit resets; a later verify restores it', async () => {
    const a = await signup(t.app);
    const d = (await add(a, dom())).json();
    t.dns.set(d.txtName, [d.txtValue]);
    expect((await verify(a, d.id)).statusCode).toBe(200);
    const week = LIMITS.ssoDomainRecheckHours * 3_600_000;
    let now = Date.now();
    // a hit: still verified
    now += week + 60_000;
    await recheckDomains(t.ctx, new Date(now));
    let list = (await call(t.app, '/api/v1/orgs/current/sso/domains', { cookie: a.cookie })).json().items;
    expect(list[0].status).toBe('verified');
    // three misses, a week apart
    t.dns.clear(d.txtName);
    for (let i = 0; i < 2; i++) {
      now += week + 60_000;
      await sweepSsoDomains(t.ctx, new Date(now));
      list = (await call(t.app, '/api/v1/orgs/current/sso/domains', { cookie: a.cookie })).json().items;
      expect(list[0].status).toBe('verified');
    }
    // not yet due: nothing happens
    await recheckDomains(t.ctx, new Date(now + 60_000));
    expect((await call(t.app, '/api/v1/orgs/current/sso/domains', { cookie: a.cookie })).json().items[0].status).toBe('verified');
    now += week + 60_000;
    await sweepSsoDomains(t.ctx, new Date(now));
    list = (await call(t.app, '/api/v1/orgs/current/sso/domains', { cookie: a.cookie })).json().items;
    expect(list[0].status).toBe('lapsed');
    expect((await auditOf(t.app, a.cookie, 'sso.domain_lapsed'))[0]?.data).toEqual({ domainId: d.id, domain: d.domain });
    // a lapsed domain no longer routes discovery
    const disc = await call(t.app, '/api/v1/auth/sso/discover', { body: { email: `x@${d.domain}` } });
    expect(disc.json().mode).toBe('password');
    t.dns.set(d.txtName, [d.txtValue]);
    const back = await verify(a, d.id);
    expect(back.json().status).toBe('verified');
  });
});

describe('removal and roles', () => {
  it('deletes a domain with 204 and chains sso.domain_removed', async () => {
    const d = (await add(admin, dom())).json();
    const r = await call(t.app, `/api/v1/orgs/current/sso/domains/${d.id}`, { method: 'DELETE', cookie: admin.cookie });
    expect(r.statusCode).toBe(204);
    expect((await auditOf(t.app, admin.cookie, 'sso.domain_removed'))[0]?.data).toEqual({ domainId: d.id, domain: d.domain });
  });

  it('auditors read, only org_admins write; technicians and observers are forbidden', async () => {
    const roleUser = async (role: string) => {
      const email = `${role}${randomBytes(3).toString('hex')}@example.test`;
      const inv = await call(t.app, '/api/v1/users/invite', { cookie: admin.cookie, body: { email, name: role, role } });
      const invite = new URL(inv.json().inviteUrl as string).hash.replace('#i=', '');
      const acc = await call(t.app, '/api/v1/auth/accept-invite', { body: { invite, name: role, password: PASSWORD } });
      return cookieOf(acc);
    };
    const auditor = await roleUser('auditor');
    expect((await call(t.app, '/api/v1/orgs/current/sso/domains', { cookie: auditor })).statusCode).toBe(200);
    expect((await call(t.app, '/api/v1/orgs/current/sso', { cookie: auditor })).statusCode).toBe(200);
    expect((await call(t.app, '/api/v1/orgs/current/sso/domains', { cookie: auditor, body: { domain: dom() } })).statusCode).toBe(403);
    const tech = await roleUser('technician');
    expect((await call(t.app, '/api/v1/orgs/current/sso', { cookie: tech })).statusCode).toBe(403);
    expect((await call(t.app, '/api/v1/orgs/current/sso/domains', { cookie: tech })).statusCode).toBe(403);
    const obs = await roleUser('observer');
    expect((await call(t.app, '/api/v1/orgs/current/sso', { cookie: obs })).statusCode).toBe(403);
    expect((await call(t.app, '/api/v1/orgs/current/sso')).statusCode).toBe(401);
  });
});
