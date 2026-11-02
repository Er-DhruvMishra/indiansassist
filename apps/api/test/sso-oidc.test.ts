/**
 * Phase E section 15.2: OIDC sign-in against an in-process fake IdP (discovery, JWKS, token with PKCE, userinfo; ID
 * tokens signed with jose). Section 3.4 O1-O8 and the begin route's cross-site guard.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { discoverOidc } from '../src/sso/oidc.js';
import { call, signup, type Account, type TestApp } from './helpers.js';
import {
  adminWithDomain,
  begin,
  bindingCookieOf,
  location,
  makeSsoApp,
  oidcConfig,
  oidcLogin,
  sessionCookieOf,
  startFakeOidc,
  verifyDomain,
  type FakeDns,
  type FakeOidc,
} from './sso-fakes.js';

const WEB = 'http://localhost:5173';

let t: TestApp & { dns: FakeDns };
let fake: FakeOidc;
let admin: Account & { email: string };
let domain: string;

async function configure(a: Account, over: Record<string, unknown> = {}, oidcOver: Record<string, unknown> = {}, f: FakeOidc = fake) {
  const r = await call(t.app, '/api/v1/orgs/current/sso', {
    method: 'PUT',
    cookie: a.cookie,
    body: { config: oidcConfig(f, over, oidcOver), clientSecret: f.clientSecret },
  });
  return r;
}

function err(res: { headers: Record<string, unknown> }): string | null {
  const l = String(res.headers['location'] ?? '');
  return l.includes('sso_error=') ? new URL(l).searchParams.get('sso_error') : null;
}

beforeAll(async () => {
  t = await makeSsoApp();
  fake = await startFakeOidc();
  domain = `acme${randomBytes(3).toString('hex')}.test`;
  admin = await adminWithDomain(t, domain);
  const r = await configure(admin);
  expect(r.statusCode, r.body).toBe(200);
  await verifyDomain(t, admin, domain);
});

afterAll(async () => {
  await fake?.close();
  await t?.close();
});

describe('OIDC happy path', () => {
  it('begins with PKCE S256 on the per-org redirect URI and signs a JIT user in', async () => {
    const b = await begin(t.app, admin.org.slug, { query: 'login_hint=x%40y.test&return_to=%2Fapp%2Fsessions' });
    expect(b.statusCode).toBe(302);
    const auth = new URL(location(b));
    expect(auth.origin + auth.pathname).toBe(`${fake.issuer}/authorize`);
    expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
    expect(auth.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(auth.searchParams.get('redirect_uri')).toBe(`http://localhost:4000/api/v1/auth/sso/oidc/${admin.org.id}/callback`);
    expect(auth.searchParams.get('login_hint')).toBe('x@y.test');
    expect(auth.searchParams.get('nonce')).toBeTruthy();
    const cookie = bindingCookieOf(b);
    expect(cookie.line).toMatch(/HttpOnly/i);
    expect(cookie.line).toMatch(/SameSite=Lax/i);
    expect(cookie.line).toMatch(/Path=\/api\/v1\/auth\/sso/);

    const q = fake.authorize(location(b), { sub: 'u-1', email: `newbie@${domain}`, email_verified: true, name: 'New Bie' });
    const cb = await call(t.app, `/api/v1/auth/sso/oidc/${admin.org.id}/callback?${q}`, { cookie: cookie.pair });
    expect(cb.statusCode).toBe(303);
    expect(location(cb)).toBe(`${WEB}/app/sessions`);
    const session = sessionCookieOf(cb);
    expect(session).toBeTruthy();
    const me = await call(t.app, '/api/v1/auth/me', { cookie: session! });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.role).toBe('technician');
    // the token request carried the PKCE verifier and client authentication
    const tr = fake.tokenRequests.at(-1)!;
    expect(tr.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    // a second login resolves through the identity (rule 1)
    const again = await oidcLogin(t.app, fake, admin.org.slug, admin.org.id, { sub: 'u-1', email: `newbie@${domain}`, email_verified: true });
    expect(again.statusCode).toBe(303);
    expect(sessionCookieOf(again)).toBeTruthy();
  });

  it('two concurrent flows in one browser both complete', async () => {
    const b1 = await begin(t.app, admin.org.slug);
    const b2 = await begin(t.app, admin.org.slug);
    const c1 = bindingCookieOf(b1).pair;
    const c2 = bindingCookieOf(b2).pair;
    expect(c1.split('=')[0]).not.toBe(c2.split('=')[0]);
    const both = `${c1}; ${c2}`;
    const q1 = fake.authorize(location(b1), { sub: 'u-2', email: `two@${domain}`, email_verified: true });
    const q2 = fake.authorize(location(b2), { sub: 'u-2', email: `two@${domain}`, email_verified: true });
    const r2 = await call(t.app, `/api/v1/auth/sso/oidc/${admin.org.id}/callback?${q2}`, { cookie: both });
    const r1 = await call(t.app, `/api/v1/auth/sso/oidc/${admin.org.id}/callback?${q1}`, { cookie: both });
    expect(err(r1)).toBeNull();
    expect(err(r2)).toBeNull();
    expect(sessionCookieOf(r1)).toBeTruthy();
    expect(sessionCookieOf(r2)).toBeTruthy();
  });
});

describe('OIDC refusals', () => {
  const user = () => ({ sub: `s-${randomBytes(3).toString('hex')}`, email: `r${randomBytes(3).toString('hex')}@${domain}`, email_verified: true });

  it('a wrong or missing code_verifier is refused by the IdP', async () => {
    const b = await begin(t.app, admin.org.slug);
    const q = fake.authorize(location(b), user());
    // replace the challenge the fake stored by authorizing a different URL: the verifier no longer matches
    const auth = new URL(location(b));
    auth.searchParams.set('code_challenge', 'A'.repeat(43));
    const q2 = fake.authorize(auth.href, user());
    q2.set('state', q.get('state')!);
    const r = await call(t.app, `/api/v1/auth/sso/oidc/${admin.org.id}/callback?${q2}`, { cookie: bindingCookieOf(b).pair });
    expect(err(r)).toBe('idp_error');
    expect(sessionCookieOf(r)).toBeNull();
  });

  it('state, binding cookie and nonce mismatches', async () => {
    // unknown state
    const r0 = await call(t.app, `/api/v1/auth/sso/oidc/${admin.org.id}/callback?code=x&state=nope`);
    expect(err(r0)).toBe('flow_expired');
    // binding cookie missing / wrong
    const b = await begin(t.app, admin.org.slug);
    const q = fake.authorize(location(b), user());
    const r1 = await call(t.app, `/api/v1/auth/sso/oidc/${admin.org.id}/callback?${q}`, { cookie: `${bindingCookieOf(b).pair.split('=')[0]}=wrong` });
    expect(err(r1)).toBe('binding_mismatch');
    // the flow was consumed: a replay of the same callback is flow_expired
    const r2 = await call(t.app, `/api/v1/auth/sso/oidc/${admin.org.id}/callback?${q}`, { cookie: bindingCookieOf(b).pair });
    expect(err(r2)).toBe('flow_expired');
    // nonce mismatch in the ID token
    const r3 = await oidcLogin(t.app, fake, admin.org.slug, admin.org.id, user(), { claims: { nonce: 'other' } });
    expect(err(r3)).toBe('invalid_response');
  });

  it('a flow begun for org B completed on org A callback is binding_mismatch', async () => {
    const domB = `orgb${randomBytes(3).toString('hex')}.test`;
    const adminB = await adminWithDomain(t, domB);
    expect((await configure(adminB)).statusCode).toBe(200);
    const b = await begin(t.app, adminB.org.slug);
    const q = fake.authorize(location(b), user());
    const r = await call(t.app, `/api/v1/auth/sso/oidc/${admin.org.id}/callback?${q}`, { cookie: bindingCookieOf(b).pair });
    expect(err(r)).toBe('binding_mismatch');
    expect(sessionCookieOf(r)).toBeNull();
  });

  it('RFC 9207: a wrong iss is refused, a missing one is refused when discovery advertises support', async () => {
    const r1 = await oidcLogin(t.app, fake, admin.org.slug, admin.org.id, user(), {}, { iss: 'http://127.0.0.1:1/evil' });
    expect(err(r1)).toBe('invalid_response');
    const f2 = await startFakeOidc();
    f2.discovery['authorization_response_iss_parameter_supported'] = true;
    const dom = `iss${randomBytes(3).toString('hex')}.test`;
    const a2 = await adminWithDomain(t, dom);
    expect((await configure(a2, {}, {}, f2)).statusCode).toBe(200);
    await verifyDomain(t, a2, dom);
    const r2 = await oidcLogin(t.app, f2, a2.org.slug, a2.org.id, { sub: 'z', email: `z@${dom}`, email_verified: true }, {}, { iss: null });
    expect(err(r2)).toBe('invalid_response');
    const r3 = await oidcLogin(t.app, f2, a2.org.slug, a2.org.id, { sub: 'z', email: `z@${dom}`, email_verified: true });
    expect(err(r3)).toBeNull();
    await f2.close();
  });

  it('wrong iss, aud, azp in the token, an expired token, HS256 and none are refused', async () => {
    const cases: [string, Parameters<typeof oidcLogin>[5]][] = [
      ['iss', { claims: { iss: 'http://127.0.0.1:1' } }],
      ['aud', { claims: { aud: 'someone-else' } }],
      ['azp', { claims: { aud: [fake.clientId, 'other'], azp: 'other' } }],
      ['azp missing with several aud', { claims: { aud: [fake.clientId, 'other'] } }],
      ['expired', { claims: { exp: Math.floor(Date.now() / 1000) - 3600, iat: Math.floor(Date.now() / 1000) - 7200 } }],
      ['HS256', { alg: 'HS256' }],
      ['none', { alg: 'none' }],
    ];
    for (const [name, tweak] of cases) {
      const r = await oidcLogin(t.app, fake, admin.org.slug, admin.org.id, user(), tweak);
      expect(err(r), name).toBe('invalid_response');
      expect(sessionCookieOf(r), name).toBeNull();
    }
  });

  it('email_verified false is refused; email from userinfo with a sub mismatch is refused', async () => {
    const r1 = await oidcLogin(t.app, fake, admin.org.slug, admin.org.id, { ...user(), email_verified: false });
    expect(err(r1)).toBe('email_unverified');
    const u = user();
    const ok = await oidcLogin(t.app, fake, admin.org.slug, admin.org.id, u, { emailInUserinfoOnly: true });
    expect(err(ok)).toBeNull();
    const r2 = await oidcLogin(t.app, fake, admin.org.slug, admin.org.id, user(), { emailInUserinfoOnly: true, userinfoSub: 'other-sub' });
    expect(err(r2)).toBe('invalid_response');
  });

  it('discovery whose issuer differs is refused at save', async () => {
    const f = await startFakeOidc();
    f.discovery['issuer'] = 'http://127.0.0.1:1/other';
    const r = await configure(admin, {}, {}, f);
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('sso_discovery_failed');
    expect(r.json().error.details.cause).toBe('issuer_mismatch');
    await f.close();
  });

  it('a Google issuer without requiredClaims is refused at save, and a token failing hd is claim_mismatch', async () => {
    const r = await call(t.app, '/api/v1/orgs/current/sso', {
      method: 'PUT',
      cookie: admin.cookie,
      body: { config: oidcConfig({ issuer: 'https://accounts.google.com', clientId: 'x' }), clientSecret: 's' },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('validation_failed');
    const dom = `hd${randomBytes(3).toString('hex')}.test`;
    const a = await adminWithDomain(t, dom);
    expect((await configure(a, {}, { requiredClaims: [{ name: 'hd', values: [dom] }] })).statusCode).toBe(200);
    await verifyDomain(t, a, dom);
    const bad = await oidcLogin(t.app, fake, a.org.slug, a.org.id, { sub: 'g1', email: `g1@${dom}`, email_verified: true, hd: 'gmail.com' });
    expect(err(bad)).toBe('claim_mismatch');
    const none = await oidcLogin(t.app, fake, a.org.slug, a.org.id, { sub: 'g2', email: `g2@${dom}`, email_verified: true });
    expect(err(none)).toBe('claim_mismatch');
    const good = await oidcLogin(t.app, fake, a.org.slug, a.org.id, { sub: 'g3', email: `g3@${dom}`, email_verified: true, hd: dom });
    expect(err(good)).toBeNull();
  });

  it('an IdP error parameter is idp_error and chains auth.sso_failed', async () => {
    const b = await begin(t.app, admin.org.slug);
    const state = new URL(location(b)).searchParams.get('state')!;
    const r = await call(t.app, `/api/v1/auth/sso/oidc/${admin.org.id}/callback?error=access_denied&state=${state}`, {
      cookie: bindingCookieOf(b).pair,
    });
    expect(err(r)).toBe('idp_error');
    const audit = await call(t.app, '/api/v1/audit?action=auth.sso_failed', { cookie: admin.cookie });
    expect(audit.statusCode).toBe(200);
    const items = audit.json().items as { action: string; data: { cause: string; protocol: string } }[];
    expect(items.some((i) => i.data.cause === 'idp_error' && i.data.protocol === 'oidc')).toBe(true);
  });
});

describe('begin route', () => {
  it('cross-site or absent Sec-Fetch-Site goes to the interstitial; same-origin and none go to the IdP', async () => {
    const cross = await begin(t.app, admin.org.slug, { headers: { 'sec-fetch-site': 'cross-site' }, query: 'login_hint=a%40b.test' });
    expect(cross.statusCode).toBe(303);
    const cu = new URL(location(cross));
    expect(cu.origin + cu.pathname).toBe(`${WEB}/sso/continue`);
    expect(cu.searchParams.get('org')).toBe(admin.org.slug);
    expect(cu.searchParams.get('login_hint')).toBe('a@b.test');
    const absent = await call(t.app, `/api/v1/auth/sso/${admin.org.slug}/begin`);
    expect(new URL(location(absent)).pathname).toBe('/sso/continue');
    for (const site of ['same-origin', 'none']) {
      const r = await begin(t.app, admin.org.slug, { headers: { 'sec-fetch-site': site } });
      expect(r.statusCode, site).toBe(302);
      expect(location(r).startsWith(fake.issuer)).toBe(true);
    }
  });

  it('same-site passes only with a Referer from WEB_ORIGIN', async () => {
    const ok = await begin(t.app, admin.org.slug, { headers: { 'sec-fetch-site': 'same-site', referer: `${WEB}/login` } });
    expect(ok.statusCode).toBe(302);
    const bad = await begin(t.app, admin.org.slug, { headers: { 'sec-fetch-site': 'same-site', referer: 'http://evil.localhost:5173/' } });
    expect(new URL(location(bad)).pathname).toBe('/sso/continue');
    const none = await begin(t.app, admin.org.slug, { headers: { 'sec-fetch-site': 'same-site' } });
    expect(new URL(location(none)).pathname).toBe('/sso/continue');
  });

  it('an unknown org or SSO off redirects to /login?sso_error=sso_disabled; return_to is kept only when safe', async () => {
    const r = await begin(t.app, 'no-such-org');
    expect(location(r)).toBe(`${WEB}/login?sso_error=sso_disabled`);
    const plain = await signup(t.app);
    const r2 = await begin(t.app, plain.org.slug);
    expect(err(r2)).toBe('sso_disabled');
    const evil = await begin(t.app, admin.org.slug, { query: 'return_to=%2F%2Fevil.test' });
    const q = fake.authorize(location(evil), { sub: 'rt', email: `rt@${domain}`, email_verified: true });
    const cb = await call(t.app, `/api/v1/auth/sso/oidc/${admin.org.id}/callback?${q}`, { cookie: bindingCookieOf(evil).pair });
    expect(location(cb)).toBe(`${WEB}/app`);
  });

  it('info names the org and the IdP; 404 when SSO is off', async () => {
    const r = await call(t.app, `/api/v1/auth/sso/${admin.org.slug}/info`);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ orgName: expect.any(String), displayName: 'Acme IdP', protocol: 'oidc' });
    expect((await call(t.app, '/api/v1/auth/sso/no-such-org/info')).statusCode).toBe(404);
  });

  it('the discovery cache misses after a clientId change', async () => {
    const f = await startFakeOidc({ clientId: 'first' });
    const orgId = admin.org.id;
    const d1 = await discoverOidc(t.ctx, orgId, { issuer: f.issuer, clientId: 'first' });
    expect(d1.ok && d1.metadata.authorization_endpoint).toBe(`${f.issuer}/authorize`);
    f.discovery['authorization_endpoint'] = `${f.issuer}/authorize2`;
    const cached = await discoverOidc(t.ctx, orgId, { issuer: f.issuer, clientId: 'first' });
    expect(cached.ok && cached.metadata.authorization_endpoint).toBe(`${f.issuer}/authorize`);
    const changed = await discoverOidc(t.ctx, orgId, { issuer: f.issuer, clientId: 'second' });
    expect(changed.ok && changed.metadata.authorization_endpoint).toBe(`${f.issuer}/authorize2`);
    await f.close();
  });
});

describe('discover', () => {
  it('answers by domain only', async () => {
    const r = await call(t.app, '/api/v1/auth/sso/discover', { body: { email: `nobody@${domain}` } });
    expect(r.json()).toEqual({ mode: 'sso_available', displayName: 'Acme IdP', beginUrl: `/api/v1/auth/sso/${admin.org.slug}/begin?login_hint=nobody%40${domain}` });
    const p = await call(t.app, '/api/v1/auth/sso/discover', { body: { email: 'someone@unknown-domain.test' } });
    expect(p.json()).toEqual({ mode: 'password' });
    const bad = await call(t.app, '/api/v1/auth/sso/discover', { body: {} });
    expect(bad.statusCode).toBe(400);
  });
});
