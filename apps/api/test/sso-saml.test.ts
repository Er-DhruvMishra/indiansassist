/**
 * Phase E section 15.2: SAML 2.0 SP-initiated sign-in against an in-process fake IdP (Responses built and signed with
 * xml-crypto and a test RSA key). Section 3.5 S1-S8, including the checks node-saml 5.2 does not make itself.
 */
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryPresence } from '../src/adapters/presence.js';
import { getOrg } from '@indiansassist/db';
import { parseSsoConfig } from '@indiansassist/shared';
import { buildSaml, PresenceSamlCache, recordSamlAssertionId, SAML_REQ_PREFIX, samlChecks } from '../src/sso/saml.js';
import { call, type Account, type TestApp } from './helpers.js';
import {
  adminWithDomain,
  DIGEST_SHA1,
  makeEcCertPem,
  makeSamlIdp,
  makeSsoApp,
  postAcs,
  samlBegin,
  samlConfig,
  samlResponse,
  sessionCookieOf,
  verifyDomain,
  XMLDSIG_RSA_SHA1,
  type FakeDns,
  type SamlIdp,
  type SamlResponseOpts,
} from './sso-fakes.js';

const WEB = 'http://localhost:5173';
const API = 'http://localhost:4000';

let t: TestApp & { dns: FakeDns };
let idp: SamlIdp;
let admin: Account & { email: string };
let domain: string;

const acsOf = (orgId: string) => `${API}/api/v1/auth/sso/saml/${orgId}/acs`;
const entityOf = (orgId: string) => `${API}/api/v1/auth/sso/saml/${orgId}/metadata`;

function err(res: { headers: Record<string, unknown> }): string | null {
  const l = String(res.headers['location'] ?? '');
  return l.includes('sso_error=') ? new URL(l).searchParams.get('sso_error') : null;
}

async function configure(a: Account, over: Record<string, unknown> = {}, samlOver: Record<string, unknown> = {}, i: SamlIdp = idp) {
  return call(t.app, '/api/v1/orgs/current/sso', { method: 'PUT', cookie: a.cookie, body: { config: samlConfig(i, over, samlOver) } });
}

/** A full SP-initiated round trip with `tweak` applied to the Response. */
async function login(a: Account, email: string, tweak: Partial<SamlResponseOpts> = {}, i: SamlIdp = idp) {
  const f = await samlBegin(t.app, a.org.slug);
  const resp = await samlResponse(i, {
    acsUrl: acsOf(a.org.id),
    audience: entityOf(a.org.id),
    inResponseTo: f.requestId,
    nameId: email,
    attributes: { displayName: ['Sam L'], groups: ['staff'] },
    ...tweak,
  });
  const res = await postAcs(t.app, a.org.id, { SAMLResponse: resp, RelayState: f.relayState }, f.cookie);
  return { res, flow: f, resp };
}

const email = () => `s${randomBytes(3).toString('hex')}@${domain}`;

beforeAll(async () => {
  t = await makeSsoApp();
  idp = await makeSamlIdp();
  domain = `saml${randomBytes(3).toString('hex')}.test`;
  admin = await adminWithDomain(t, domain);
  const r = await configure(admin);
  expect(r.statusCode, r.body).toBe(200);
  await verifyDomain(t, admin, domain);
});

afterAll(async () => {
  await t?.close();
});

describe('SAML happy path', () => {
  it('a valid signed assertion signs a JIT user in with a SameSite=None binding cookie', async () => {
    const f = await samlBegin(t.app, admin.org.slug, { query: 'return_to=%2Fapp%2Faudit' });
    expect(f.cookie).toMatch(/^ia_sso_/);
    const line = (f.res.headers['set-cookie'] as string[] | string).toString();
    expect(line).toMatch(/SameSite=None/i);
    expect(line).toMatch(/Secure/i);
    const u = new URL(String(f.res.headers['location']));
    expect(u.origin + u.pathname).toBe('http://127.0.0.1:9/sso');
    const e = email();
    const resp = await samlResponse(idp, {
      acsUrl: acsOf(admin.org.id),
      audience: entityOf(admin.org.id),
      inResponseTo: f.requestId,
      nameId: e,
      attributes: { displayName: ['Sam L'] },
    });
    // the ACS is CSRF-exempt: no X-Requested-With, a foreign Origin
    const res = await postAcs(t.app, admin.org.id, { SAMLResponse: resp, RelayState: f.relayState }, f.cookie);
    expect(err(res)).toBeNull();
    expect(res.headers['location']).toBe(`${WEB}/app/audit`);
    const s = sessionCookieOf(res);
    expect(s).toBeTruthy();
    const me = await call(t.app, '/api/v1/auth/me', { cookie: s! });
    expect(me.json().user.name).toBe('Sam L');
    expect(me.json().user.email).toBe(e);
  });

  it('a signed Response with Destination is accepted, and a missing Destination on an unsigned Response is accepted', async () => {
    const r1 = await login(admin, email(), { signResponse: true });
    expect(err(r1.res)).toBeNull();
    const r2 = await login(admin, email(), { destination: null });
    expect(err(r2.res)).toBeNull();
  });

  it('serves the metadata document', async () => {
    const r = await call(t.app, `/api/v1/auth/sso/saml/${admin.org.id}/metadata`);
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/application\/samlmetadata\+xml/);
    expect(r.headers['cache-control']).toBe('public, max-age=300');
    expect(r.body).toContain(`entityID="${entityOf(admin.org.id)}"`);
    expect(r.body).toContain(acsOf(admin.org.id));
    const none = await call(t.app, `/api/v1/auth/sso/saml/${randomUuid()}/metadata`);
    expect(none.statusCode).toBe(404);
  });
});

function randomUuid(): string {
  const h = randomBytes(16).toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

describe('SAML refusals', () => {
  it('unsigned assertion, unknown certificate, wrong audience', async () => {
    expect(err((await login(admin, email(), { signAssertion: false })).res)).toBe('invalid_response');
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(err((await login(admin, email(), { signingKey: other })).res)).toBe('invalid_response');
    expect(err((await login(admin, email(), { audience: 'https://someone-else.test/sp' })).res)).toBe('invalid_response');
  });

  it('RSA-SHA1 signatures and SHA-1 digests are refused by our check (xml-crypto alone accepts them)', async () => {
    expect(err((await login(admin, email(), { signatureAlgorithm: XMLDSIG_RSA_SHA1 })).res)).toBe('invalid_response');
    expect(err((await login(admin, email(), { digestAlgorithm: DIGEST_SHA1 })).res)).toBe('invalid_response');
  });

  it('wrong Recipient; wrong or missing Destination on a signed Response', async () => {
    expect(err((await login(admin, email(), { recipient: 'https://evil.test/acs' })).res)).toBe('invalid_response');
    expect(err((await login(admin, email(), { signResponse: true, destination: 'https://evil.test/acs' })).res)).toBe('invalid_response');
    expect(err((await login(admin, email(), { signResponse: true, destination: null })).res)).toBe('invalid_response');
    expect(err((await login(admin, email(), { destination: 'https://evil.test/acs' })).res)).toBe('invalid_response');
  });

  it('no AuthnStatement, expired NotOnOrAfter, two SubjectConfirmations, unknown InResponseTo', async () => {
    expect(err((await login(admin, email(), { authnStatement: false })).res)).toBe('invalid_response');
    expect(err((await login(admin, email(), { notOnOrAfterMs: Date.now() - 10 * 60_000 })).res)).toBe('invalid_response');
    expect(err((await login(admin, email(), { confirmations: 2 })).res)).toBe('invalid_response');
    expect(err((await login(admin, email(), { inResponseTo: '_unknown', subjectInResponseTo: '_unknown' })).res)).toBe('invalid_response');
  });

  it('signature wrapping: a second unsigned assertion, and a Recipient changed outside the signed element', async () => {
    const e = email();
    const wrapped = await login(admin, e, {
      extraAfterAssertion: `<saml:Assertion ID="_evil" Version="2.0" IssueInstant="${new Date().toISOString()}"><saml:Issuer>${idp.entityId}</saml:Issuer><saml:Subject><saml:NameID>attacker@${domain}</saml:NameID></saml:Subject></saml:Assertion>`,
    });
    expect(err(wrapped.res)).toBe('invalid_response');
    // The signed assertion names the attacker's ACS as Recipient; an unsigned copy elsewhere names ours. Our check
    // reads only profile.getAssertionXml(), so the signed (wrong) Recipient decides.
    const recipientOutside = await login(admin, email(), {
      recipient: 'https://evil.test/acs',
      extraAfterAssertion: `<samlp:Extensions><saml:SubjectConfirmationData Recipient="${acsOf(admin.org.id)}"/></samlp:Extensions>`,
    });
    expect(err(recipientOutside.res)).toBe('invalid_response');
    // A signed assertion whose content is altered after signing fails the signature.
    const altered = await login(admin, email(), { mutateSignedAssertion: (x) => x.replace(/Recipient="[^"]+"/, `Recipient="https://evil.test/acs"`) });
    expect(err(altered.res)).toBe('invalid_response');
  });

  it('unsolicited (no RelayState), a flow begun for org B posted to org A ACS, and a DOCTYPE', async () => {
    const f = await samlBegin(t.app, admin.org.slug);
    const resp = await samlResponse(idp, { acsUrl: acsOf(admin.org.id), audience: entityOf(admin.org.id), inResponseTo: f.requestId, nameId: email() });
    expect(err(await postAcs(t.app, admin.org.id, { SAMLResponse: resp }, f.cookie))).toBe('unsolicited');

    const domB = `b${randomBytes(3).toString('hex')}.test`;
    const adminB = await adminWithDomain(t, domB);
    expect((await configure(adminB)).statusCode).toBe(200);
    const fb = await samlBegin(t.app, adminB.org.slug);
    const respB = await samlResponse(idp, { acsUrl: acsOf(admin.org.id), audience: entityOf(admin.org.id), inResponseTo: fb.requestId, nameId: email() });
    const r = await postAcs(t.app, admin.org.id, { SAMLResponse: respB, RelayState: fb.relayState }, fb.cookie);
    expect(err(r)).toBe('binding_mismatch');
    expect(sessionCookieOf(r)).toBeNull();

    expect(err((await login(admin, email(), { doctype: true })).res)).toBe('invalid_response');
  });

  it('the binding cookie must match', async () => {
    const f = await samlBegin(t.app, admin.org.slug);
    const resp = await samlResponse(idp, { acsUrl: acsOf(admin.org.id), audience: entityOf(admin.org.id), inResponseTo: f.requestId, nameId: email() });
    const r = await postAcs(t.app, admin.org.id, { SAMLResponse: resp, RelayState: f.relayState });
    expect(err(r)).toBe('binding_mismatch');
  });

  it('an EC certificate is refused at save', async () => {
    const ecIdp = { ...idp, certPem: await makeEcCertPem() };
    const r = await configure(admin, {}, {}, ecIdp);
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('sso_cert_invalid');
    expect(r.json().error.details.reason).toBe('not_rsa');
  });

  it('a body over 256 KiB is 413', async () => {
    const r = await postAcs(t.app, admin.org.id, { SAMLResponse: 'A'.repeat(270_000), RelayState: 'x' });
    expect(r.statusCode).toBe(413);
    expect(r.json().error.code).toBe('payload_too_large');
  });
});

describe('what node-saml accepts and our checks refuse', () => {
  /** node-saml alone (validatePostResponseAsync) on a Response, then our step-6 checks on what it validated. */
  async function libraryThenOurs(tweak: Partial<SamlResponseOpts>) {
    const org = (await getOrg(t.db, admin.org.id))!;
    const cfg = parseSsoConfig(org.ssoConfig)!;
    const requestId = `_req${randomBytes(8).toString('hex')}`;
    await new PresenceSamlCache(t.ctx.presence).saveAsync(requestId, new Date().toISOString());
    const resp = await samlResponse(idp, { acsUrl: acsOf(admin.org.id), audience: entityOf(admin.org.id), inResponseTo: requestId, nameId: email(), ...tweak });
    const { profile } = await buildSaml(t.ctx, org, cfg, null).validatePostResponseAsync({ SAMLResponse: resp });
    const ours = await samlChecks(
      { assertionXml: profile!.getAssertionXml!(), rawXml: Buffer.from(resp, 'base64').toString('utf8'), pemCerts: [idp.certPem], decryptionPvk: null },
      { acsUrl: acsOf(admin.org.id), requestId, clockSkewSec: 120 },
    );
    return ours;
  }

  it('accepts an untampered Response with our checks too', async () => {
    expect((await libraryThenOurs({})).ok).toBe(true);
  });

  it.each([
    ['RSA-SHA1 signature', { signatureAlgorithm: XMLDSIG_RSA_SHA1 }],
    ['SHA-1 digest', { digestAlgorithm: DIGEST_SHA1 }],
    ['wrong Recipient', { recipient: 'https://evil.test/acs' }],
    ['wrong Destination on a signed Response', { signResponse: true, destination: 'https://evil.test/acs' }],
    ['missing Destination on a signed Response', { signResponse: true, destination: null }],
    ['no AuthnStatement', { authnStatement: false }],
  ] as [string, Partial<SamlResponseOpts>][])('%s: node-saml accepts, our check refuses', async (_name, tweak) => {
    const ours = await libraryThenOurs(tweak);
    expect(ours.ok).toBe(false);
  });
});

describe('encrypted assertions', () => {
  let encAdmin: Account;
  let encDomain: string;
  let spCert: string;
  beforeAll(async () => {
    encDomain = `enc${randomBytes(3).toString('hex')}.test`;
    encAdmin = await adminWithDomain(t, encDomain);
    const k = await call(t.app, '/api/v1/orgs/current/sso/sp-key', { cookie: encAdmin.cookie, method: 'POST' });
    expect(k.statusCode).toBe(200);
    spCert = k.json().certPem;
    expect(spCert).toMatch(/^-----BEGIN CERTIFICATE-----/);
    expect((await configure(encAdmin)).statusCode).toBe(200);
    await verifyDomain(t, encAdmin, encDomain);
  });

  it('RSA-OAEP + AES-GCM is decrypted; RSA-1_5 or AES-CBC is refused before decryption', async () => {
    const ok = await login(encAdmin, `e1@${encDomain}`, { encrypt: { certPem: spCert } });
    expect(err(ok.res)).toBeNull();
    expect(sessionCookieOf(ok.res)).toBeTruthy();
    const v15 = await login(encAdmin, `e2@${encDomain}`, { encrypt: { certPem: spCert, keyAlgorithm: 'http://www.w3.org/2001/04/xmlenc#rsa-1_5' } });
    expect(err(v15.res)).toBe('invalid_response');
    const cbc = await login(encAdmin, `e3@${encDomain}`, { encrypt: { certPem: spCert, dataAlgorithm: 'http://www.w3.org/2001/04/xmlenc#aes256-cbc' } });
    expect(err(cbc.res)).toBe('invalid_response');
  });

  it('the metadata carries the SP certificate for signing and encryption', async () => {
    const r = await call(t.app, `/api/v1/auth/sso/saml/${encAdmin.org.id}/metadata`);
    expect(r.body).toMatch(/use="signing"/);
    expect(r.body).toMatch(/use="encryption"/);
  });
});

describe('replay', () => {
  it('a straight replay of the same POST is flow_expired (the flow was consumed)', async () => {
    const first = await login(admin, email());
    expect(err(first.res)).toBeNull();
    const again = await postAcs(t.app, admin.org.id, { SAMLResponse: first.resp, RelayState: first.flow.relayState }, first.flow.cookie);
    expect(err(again)).toBe('flow_expired');
  });

  it('a re-delivered assertion id is replay, through the cache function and on a second node sharing presence', async () => {
    const shared = new MemoryPresence('node-a');
    const id = `_a${randomBytes(8).toString('hex')}`;
    const later = Date.now() + 300_000;
    expect(await recordSamlAssertionId(shared, 'org-1', id, later, 120)).toBe(true);
    expect(await recordSamlAssertionId(shared, 'org-1', id, later, 120)).toBe(false);
    // another org's cache is separate
    expect(await recordSamlAssertionId(shared, 'org-2', id, later, 120)).toBe(true);
    // a second app ("node") on the same presence refuses the id this node recorded
    const t2 = await makeSsoApp();
    try {
      t2.ctx.presence = t.ctx.presence;
      const id2 = `_a${randomBytes(8).toString('hex')}`;
      expect(await recordSamlAssertionId(t.ctx.presence, admin.org.id, id2, later, 120)).toBe(true);
      expect(await recordSamlAssertionId(t2.ctx.presence, admin.org.id, id2, later, 120)).toBe(false);
    } finally {
      await t2.close();
    }
  });

  it('the request-id cache is consumed once through Presence.consume', async () => {
    const p = new MemoryPresence('node-a');
    const cache = new PresenceSamlCache(p);
    await cache.saveAsync('_req1', new Date().toISOString());
    expect(await p.getKey(`${SAML_REQ_PREFIX}_req1`)).toBeTruthy();
    expect(await cache.getAsync('_req1')).toBeTruthy();
    expect(await cache.consumeAsync('_req1')).toBeTruthy();
    expect(await cache.consumeAsync('_req1')).toBeNull();
    // and through a full flow: the begin saved the request id, the ACS consumed it
    const f = await samlBegin(t.app, admin.org.slug);
    expect(await t.ctx.presence.getKey(`${SAML_REQ_PREFIX}${f.requestId}`)).toBeTruthy();
    const resp = await samlResponse(idp, { acsUrl: acsOf(admin.org.id), audience: entityOf(admin.org.id), inResponseTo: f.requestId, nameId: email() });
    const r = await postAcs(t.app, admin.org.id, { SAMLResponse: resp, RelayState: f.relayState }, f.cookie);
    expect(err(r)).toBeNull();
    expect(await t.ctx.presence.getKey(`${SAML_REQ_PREFIX}${f.requestId}`)).toBeNull();
  });
});
