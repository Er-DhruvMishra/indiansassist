/**
 * In-process fakes for the Phase E SSO tests (docs/specs/phase-e-contracts.md section 15.2): an OIDC provider on a
 * loopback port (discovery, JWKS, token with PKCE, userinfo; ID tokens signed with `jose`), a SAML IdP that builds and
 * signs Responses with `xml-crypto` (and encrypts with `xml-encryption`), and a fake TXT resolver. Nothing here leaves
 * the machine: every URL is 127.0.0.1.
 */
import { createHash, randomBytes, webcrypto, X509Certificate } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT, UnsecuredJWT, type JWK } from 'jose';
import { SignedXml } from 'xml-crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { installReflectMetadataShim } from '../src/sso/reflect-shim.js';
import { generateSpKey } from '../src/sso/sp-key.js';
import type { AppContext } from '../src/context.js';
import { call, makeApp, signup, type Account, type TestApp } from './helpers.js';

// ---------- app ----------

export const SSO_ENV = { EGRESS_ALLOW_HTTP: '1', EGRESS_ALLOW_LOOPBACK: '1', SIGNUP_PLAN_TIER: 'p3_portable' };

export type FakeDns = { records: Map<string, string[][]>; set(name: string, values: string[]): void; clear(name: string): void };

/** Replaces the app's TXT lookups with an in-memory table (lookups for egress keep working for IP literals). */
export function installFakeDns(ctx: AppContext): FakeDns {
  const records = new Map<string, string[][]>();
  const orig = ctx.dnsResolver;
  ctx.dnsResolver = {
    lookup: orig.lookup,
    resolveTxt: async (host: string) => {
      const r = records.get(host);
      if (!r) throw Object.assign(new Error(`queryTxt ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
      return r;
    },
  };
  return {
    records,
    set: (name, values) => records.set(name, values.map((v) => [v])),
    clear: (name) => records.delete(name),
  };
}

export async function makeSsoApp(env: Record<string, string> = {}): Promise<TestApp & { dns: FakeDns }> {
  const t = await makeApp({ ...SSO_ENV, ...env });
  return { ...t, dns: installFakeDns(t.ctx) };
}

/** Adds and verifies a domain for the signed-in admin through the fake resolver. */
export async function verifyDomain(t: { app: FastifyInstance; dns: FakeDns }, admin: Account, domain: string): Promise<string> {
  const add = await call(t.app, '/api/v1/orgs/current/sso/domains', { cookie: admin.cookie, body: { domain } });
  if (add.statusCode !== 201) throw new Error(`domain add ${add.statusCode} ${add.body}`);
  const d = add.json() as { id: string; txtName: string; txtValue: string };
  t.dns.set(d.txtName, [d.txtValue]);
  const v = await call(t.app, `/api/v1/orgs/current/sso/domains/${d.id}/verify`, { cookie: admin.cookie, method: 'POST' });
  if (v.statusCode !== 200) throw new Error(`domain verify ${v.statusCode} ${v.body}`);
  return d.id;
}

export async function adminWithDomain(t: TestApp & { dns: FakeDns }, domain: string): Promise<Account & { email: string }> {
  const local = `admin${randomBytes(3).toString('hex')}`;
  const email = `${local}@${domain}`;
  const admin = await signup(t.app, { email });
  return { ...admin, email };
}

// ---------- cookies and redirects ----------

export function setCookies(res: LightMyRequestResponse): string[] {
  const raw = res.headers['set-cookie'];
  return Array.isArray(raw) ? raw : raw ? [raw] : [];
}

/** The `name=value` of the per-flow binding cookie a begin set. */
export function bindingCookieOf(res: LightMyRequestResponse): { pair: string; line: string } {
  const line = setCookies(res).find((c) => c.startsWith('ia_sso_'));
  if (!line) throw new Error(`no binding cookie (status ${res.statusCode}: ${res.body})`);
  return { pair: line.split(';')[0]!, line };
}

export function sessionCookieOf(res: LightMyRequestResponse): string | null {
  const c = setCookies(res).find((x) => x.startsWith('ia_session='));
  return c ? c.split(';')[0]! : null;
}

export function location(res: LightMyRequestResponse): string {
  const l = res.headers['location'];
  return typeof l === 'string' ? l : '';
}

export async function begin(
  app: FastifyInstance,
  slug: string,
  opts: { query?: string; headers?: Record<string, string>; cookie?: string } = {},
): Promise<LightMyRequestResponse> {
  return call(app, `/api/v1/auth/sso/${slug}/begin${opts.query ? `?${opts.query}` : ''}`, {
    headers: { 'sec-fetch-site': 'none', ...(opts.headers ?? {}) },
    ...(opts.cookie ? { cookie: opts.cookie } : {}),
  });
}

// ---------- OIDC ----------

export type OidcUser = { sub: string; email?: string; email_verified?: boolean; name?: string; groups?: string[]; [k: string]: unknown };

export type IdTokenTweak = {
  claims?: Record<string, unknown>;
  omit?: string[];
  alg?: 'RS256' | 'HS256' | 'none';
  /** Leave the email out of the ID token (userinfo still has it). */
  emailInUserinfoOnly?: boolean;
  userinfoSub?: string;
};

type CodeRecord = {
  user: OidcUser;
  clientId: string;
  redirectUri: string;
  challenge: string;
  nonce: string;
  tweak: IdTokenTweak;
};

export type FakeOidc = {
  issuer: string;
  clientId: string;
  clientSecret: string;
  discovery: Record<string, unknown>;
  tokenRequests: URLSearchParams[];
  /** What the authorization endpoint would do: returns the callback query (`code`, `state`, `iss`). */
  authorize(authUrl: string, user: OidcUser, tweak?: IdTokenTweak, opts?: { iss?: string | null }): URLSearchParams;
  close(): Promise<void>;
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (c: Buffer) => (s += c.toString('utf8')));
    req.on('end', () => resolve(s));
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export async function startFakeOidc(opts: { clientId?: string; clientSecret?: string; issPathSuffix?: string } = {}): Promise<FakeOidc> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const codes = new Map<string, CodeRecord>();
  const tokens = new Map<string, OidcUser & { __tweak?: IdTokenTweak }>();
  const tokenRequests: URLSearchParams[] = [];
  const clientId = opts.clientId ?? 'ia-client';
  const clientSecret = opts.clientSecret ?? 'ia-secret-0123456789';
  let issuer = '';
  const discovery: Record<string, unknown> = {};
  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', issuer);
      if (url.pathname.endsWith('/.well-known/openid-configuration')) return json(res, 200, discovery);
      if (url.pathname.endsWith('/jwks')) return json(res, 200, { keys: [jwk] });
      if (url.pathname.endsWith('/token') && req.method === 'POST') {
        const form = new URLSearchParams(await readBody(req));
        tokenRequests.push(form);
        const basic = /^Basic (.+)$/.exec(req.headers['authorization'] ?? '');
        let id = form.get('client_id');
        let secret = form.get('client_secret');
        if (basic) {
          const [u, p] = Buffer.from(basic[1]!, 'base64').toString('utf8').split(':');
          id = decodeURIComponent(u ?? '');
          secret = decodeURIComponent(p ?? '');
        }
        const rec = codes.get(form.get('code') ?? '');
        if (!rec) return json(res, 400, { error: 'invalid_grant' });
        codes.delete(form.get('code')!);
        if (id !== rec.clientId || (secret !== null && secret !== clientSecret)) return json(res, 401, { error: 'invalid_client' });
        if (form.get('redirect_uri') !== rec.redirectUri) return json(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri' });
        const verifier = form.get('code_verifier') ?? '';
        const challenge = createHash('sha256').update(verifier).digest('base64url');
        if (!verifier || challenge !== rec.challenge) return json(res, 400, { error: 'invalid_grant', error_description: 'pkce' });
        const now = Math.floor(Date.now() / 1000);
        const t = rec.tweak;
        const claims: Record<string, unknown> = { iss: issuer, aud: rec.clientId, iat: now, exp: now + 300, nonce: rec.nonce, ...rec.user };
        if (t.emailInUserinfoOnly) delete claims['email'];
        Object.assign(claims, t.claims ?? {});
        for (const k of t.omit ?? []) delete claims[k];
        let idToken: string;
        if (t.alg === 'HS256') idToken = await new SignJWT(claims).setProtectedHeader({ alg: 'HS256' }).sign(new TextEncoder().encode(clientSecret));
        else if (t.alg === 'none') idToken = new UnsecuredJWT(claims).encode();
        else idToken = await new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).sign(privateKey);
        const at = randomBytes(16).toString('hex');
        tokens.set(at, { ...rec.user, __tweak: t });
        return json(res, 200, { access_token: at, token_type: 'Bearer', expires_in: 300, id_token: idToken });
      }
      if (url.pathname.endsWith('/userinfo')) {
        const m = /^Bearer (.+)$/.exec(req.headers['authorization'] ?? '');
        const u = m ? tokens.get(m[1]!) : undefined;
        if (!u) return json(res, 401, { error: 'invalid_token' });
        const { __tweak, ...claims } = u;
        return json(res, 200, { ...claims, ...(__tweak?.userinfoSub ? { sub: __tweak.userinfoSub } : {}) });
      }
      return json(res, 404, { error: 'not_found' });
    })();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  issuer = `http://127.0.0.1:${port}${opts.issPathSuffix ?? ''}`;
  Object.assign(discovery, {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    userinfo_endpoint: `${issuer}/userinfo`,
    jwks_uri: `${issuer}/jwks`,
    response_types_supported: ['code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
  });
  return {
    issuer,
    clientId,
    clientSecret,
    discovery,
    tokenRequests,
    authorize(authUrl, user, tweak = {}, o = {}) {
      const u = new URL(authUrl);
      const p = u.searchParams;
      if (p.get('code_challenge_method') !== 'S256') throw new Error('PKCE S256 expected');
      const code = randomBytes(12).toString('hex');
      codes.set(code, {
        user,
        clientId: p.get('client_id') ?? '',
        redirectUri: p.get('redirect_uri') ?? '',
        challenge: p.get('code_challenge') ?? '',
        nonce: p.get('nonce') ?? '',
        tweak,
      });
      const q = new URLSearchParams({ code, state: p.get('state') ?? '' });
      const iss = o.iss === undefined ? issuer : o.iss;
      if (iss !== null) q.set('iss', iss);
      return q;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

export function oidcConfig(fake: Pick<FakeOidc, 'issuer' | 'clientId'>, over: Record<string, unknown> = {}, oidcOver: Record<string, unknown> = {}) {
  return {
    v: 1,
    protocol: 'oidc',
    enabled: true,
    displayName: 'Acme IdP',
    oidc: {
      issuer: fake.issuer,
      clientId: fake.clientId,
      tokenEndpointAuth: 'client_secret_basic',
      scopes: ['openid', 'email', 'profile'],
      emailClaim: 'email',
      nameClaim: 'name',
      groupsClaim: 'groups',
      requiredClaims: [],
      ...oidcOver,
    },
    saml: null,
    jit: { enabled: true, defaultRole: 'technician', defaultSeatTier: 'p1_browser', groupRoles: [] },
    sessionMaxAgeHours: 12,
    ...over,
  };
}

/** begin + authorize + callback; returns the callback response. */
export async function oidcLogin(
  app: FastifyInstance,
  fake: FakeOidc,
  slug: string,
  orgId: string,
  user: OidcUser,
  tweak: IdTokenTweak = {},
  opts: { iss?: string | null; cookie?: string; query?: string } = {},
): Promise<LightMyRequestResponse> {
  const b = await begin(app, slug, { query: opts.query, cookie: opts.cookie });
  if (b.statusCode !== 302) throw new Error(`begin ${b.statusCode} ${location(b)} ${b.body}`);
  const q = fake.authorize(location(b), user, tweak, { iss: opts.iss });
  const binding = bindingCookieOf(b).pair;
  return call(app, `/api/v1/auth/sso/oidc/${orgId}/callback?${q.toString()}`, {
    cookie: [binding, opts.cookie].filter(Boolean).join('; '),
  });
}

// ---------- SAML ----------

export const XMLDSIG_RSA_SHA256 = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
export const XMLDSIG_RSA_SHA1 = 'http://www.w3.org/2000/09/xmldsig#rsa-sha1';
export const DIGEST_SHA256 = 'http://www.w3.org/2001/04/xmlenc#sha256';
export const DIGEST_SHA1 = 'http://www.w3.org/2000/09/xmldsig#sha1';
const EXC_C14N = 'http://www.w3.org/2001/10/xml-exc-c14n#';
const ENVELOPED = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature';

export type SamlIdp = { entityId: string; certPem: string; privateKeyPem: string };

/** A self-signed P-256 certificate (EC IdP certificates are refused at save: xml-crypto 6 verifies no ECDSA). */
export async function makeEcCertPem(): Promise<string> {
  installReflectMetadataShim();
  const x509 = await import('@peculiar/x509');
  x509.cryptoProvider.set(webcrypto as never);
  const alg = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };
  const keys = await webcrypto.subtle.generateKey(alg, true, ['sign', 'verify']);
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: '01',
    name: 'CN=ec.example.test',
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 365 * 86_400_000),
    signingAlgorithm: alg,
    keys: keys as never,
  });
  return cert.toString('pem');
}

export async function makeSamlIdp(entityId = 'https://idp.example.test/saml'): Promise<SamlIdp> {
  const k = await generateSpKey(entityId);
  return { entityId, certPem: k.certPem, privateKeyPem: k.privateKeyPem };
}

export type SamlResponseOpts = {
  acsUrl: string;
  audience: string;
  inResponseTo: string;
  nameId: string;
  nameIdFormat?: string;
  attributes?: Record<string, string[]>;
  issuer?: string;
  recipient?: string;
  destination?: string | null;
  subjectInResponseTo?: string;
  notOnOrAfterMs?: number;
  sessionNotOnOrAfterMs?: number | null;
  authnStatement?: boolean;
  confirmations?: number;
  signAssertion?: boolean;
  signResponse?: boolean;
  signingKey?: string;
  signatureAlgorithm?: string;
  digestAlgorithm?: string;
  assertionId?: string;
  /** Called with the assertion after signing (wrapping attacks); returns the replacement XML. */
  mutateSignedAssertion?: (signedAssertionXml: string) => string;
  /** Extra raw XML placed in the Response after the assertion (wrapping attacks). */
  extraAfterAssertion?: string;
  encrypt?: { certPem: string; keyAlgorithm?: string; dataAlgorithm?: string };
  doctype?: boolean;
};

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function sign(xml: string, key: string, refXpath: string, issuerXpath: string, sigAlg: string, digestAlg: string): string {
  const sig = new SignedXml({ privateKey: key, signatureAlgorithm: sigAlg, canonicalizationAlgorithm: EXC_C14N });
  sig.addReference({ xpath: refXpath, digestAlgorithm: digestAlg, transforms: [ENVELOPED, EXC_C14N] });
  sig.computeSignature(xml, { location: { reference: issuerXpath, action: 'after' } });
  return sig.getSignedXml();
}

const nodeRequire = createRequire(createRequire(import.meta.url).resolve('@node-saml/node-saml'));

async function encryptAssertion(xml: string, o: NonNullable<SamlResponseOpts['encrypt']>): Promise<string> {
  const xmlenc = nodeRequire('xml-encryption') as {
    encrypt(content: string, options: Record<string, unknown>, cb: (err: Error | null, result: string) => void): void;
  };
  const rsaPub = new X509Certificate(o.certPem).publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return new Promise((resolve, reject) =>
    xmlenc.encrypt(
      xml,
      {
        rsa_pub: rsaPub,
        pem: o.certPem,
        encryptionAlgorithm: o.dataAlgorithm ?? 'http://www.w3.org/2009/xmlenc11#aes256-gcm',
        keyEncryptionAlgorithm: o.keyAlgorithm ?? 'http://www.w3.org/2001/04/xmlenc#rsa-oaep-mgf1p',
        disallowEncryptionWithInsecureAlgorithm: false,
        warnInsecureAlgorithm: false,
      },
      (err, result) => (err ? reject(err) : resolve(result)),
    ),
  );
}

/** A base64 SAMLResponse built and signed like an IdP would. */
export async function samlResponse(idp: SamlIdp, o: SamlResponseOpts): Promise<string> {
  const now = Date.now();
  const issuer = o.issuer ?? idp.entityId;
  const aid = o.assertionId ?? `_a${randomBytes(12).toString('hex')}`;
  const rid = `_r${randomBytes(12).toString('hex')}`;
  const noa = o.notOnOrAfterMs ?? now + 300_000;
  const sigAlg = o.signatureAlgorithm ?? XMLDSIG_RSA_SHA256;
  const digAlg = o.digestAlgorithm ?? DIGEST_SHA256;
  const key = o.signingKey ?? idp.privateKeyPem;
  const conf = Array.from({ length: o.confirmations ?? 1 })
    .map(
      () =>
        `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData NotOnOrAfter="${iso(noa)}" Recipient="${esc(o.recipient ?? o.acsUrl)}" InResponseTo="${esc(o.subjectInResponseTo ?? o.inResponseTo)}"/></saml:SubjectConfirmation>`,
    )
    .join('');
  const attrs = Object.entries(o.attributes ?? {})
    .map(
      ([n, vs]) =>
        `<saml:Attribute Name="${esc(n)}">${vs.map((v) => `<saml:AttributeValue xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="xs:string">${esc(v)}</saml:AttributeValue>`).join('')}</saml:Attribute>`,
    )
    .join('');
  const sessionNoa = o.sessionNotOnOrAfterMs === undefined ? now + 8 * 3_600_000 : o.sessionNotOnOrAfterMs;
  const authn =
    o.authnStatement === false
      ? ''
      : `<saml:AuthnStatement AuthnInstant="${iso(now)}" SessionIndex="_s1"${sessionNoa === null ? '' : ` SessionNotOnOrAfter="${iso(sessionNoa)}"`}><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>`;
  let assertion =
    `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${aid}" Version="2.0" IssueInstant="${iso(now)}">` +
    `<saml:Issuer>${esc(issuer)}</saml:Issuer>` +
    `<saml:Subject><saml:NameID Format="${o.nameIdFormat ?? 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress'}">${esc(o.nameId)}</saml:NameID>${conf}</saml:Subject>` +
    `<saml:Conditions NotBefore="${iso(now - 60_000)}" NotOnOrAfter="${iso(noa)}"><saml:AudienceRestriction><saml:Audience>${esc(o.audience)}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
    authn +
    (attrs ? `<saml:AttributeStatement>${attrs}</saml:AttributeStatement>` : '') +
    `</saml:Assertion>`;
  if (o.signAssertion !== false)
    assertion = sign(assertion, key, "//*[local-name(.)='Assertion']", "//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']", sigAlg, digAlg);
  if (o.mutateSignedAssertion) assertion = o.mutateSignedAssertion(assertion);
  if (o.encrypt) assertion = `<saml:EncryptedAssertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">${await encryptAssertion(assertion, o.encrypt)}</saml:EncryptedAssertion>`;
  const dest = o.destination === undefined ? o.acsUrl : o.destination;
  let xml =
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${rid}" Version="2.0" IssueInstant="${iso(now)}"${dest === null ? '' : ` Destination="${esc(dest)}"`} InResponseTo="${esc(o.inResponseTo)}">` +
    `<saml:Issuer>${esc(issuer)}</saml:Issuer>` +
    `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
    assertion +
    (o.extraAfterAssertion ?? '') +
    `</samlp:Response>`;
  if (o.signResponse)
    xml = sign(xml, key, "/*[local-name(.)='Response']", "/*[local-name(.)='Response']/*[local-name(.)='Issuer']", sigAlg, digAlg);
  if (o.doctype) xml = `<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY x "y">]>${xml}`;
  return Buffer.from(xml, 'utf8').toString('base64');
}

export function samlConfig(idp: SamlIdp, over: Record<string, unknown> = {}, samlOver: Record<string, unknown> = {}) {
  return {
    v: 1,
    protocol: 'saml',
    enabled: true,
    displayName: 'Acme SAML',
    oidc: null,
    saml: {
      idpEntityId: idp.entityId,
      ssoUrl: 'http://127.0.0.1:9/sso',
      idpCertificates: [idp.certPem],
      nameIdFormat: 'email',
      emailAttribute: null,
      nameAttribute: 'displayName',
      groupsAttribute: 'groups',
      signAuthnRequests: false,
      wantResponseSigned: false,
      clockSkewSec: 120,
      ...samlOver,
    },
    jit: { enabled: true, defaultRole: 'technician', defaultSeatTier: 'p1_browser', groupRoles: [] },
    sessionMaxAgeHours: 12,
    ...over,
  };
}

/** Starts a SAML flow: the AuthnRequest ID (from the redirect), the RelayState and the binding cookie. */
export async function samlBegin(
  app: FastifyInstance,
  slug: string,
  opts: { query?: string; cookie?: string } = {},
): Promise<{ requestId: string; relayState: string; cookie: string; res: LightMyRequestResponse }> {
  const res = await begin(app, slug, opts);
  if (res.statusCode !== 302) throw new Error(`saml begin ${res.statusCode} ${location(res)} ${res.body}`);
  const u = new URL(location(res));
  const relayState = u.searchParams.get('RelayState') ?? '';
  const zlib = await import('node:zlib');
  const xml = zlib.inflateRawSync(Buffer.from(u.searchParams.get('SAMLRequest') ?? '', 'base64')).toString('utf8');
  const requestId = /ID="([^"]+)"/.exec(xml)?.[1] ?? '';
  return { requestId, relayState, cookie: bindingCookieOf(res).pair, res };
}

export async function postAcs(
  app: FastifyInstance,
  orgId: string,
  form: Record<string, string>,
  cookie?: string,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: `/api/v1/auth/sso/saml/${orgId}/acs`,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: 'https://idp.example.test',
      ...(cookie ? { cookie } : {}),
    },
    payload: new URLSearchParams(form).toString(),
  });
}

/** `POST /sso/test`, then the begin (in the admin's browser) and the IdP round trip; returns the final redirect. */
export async function oidcTestFlow(app: FastifyInstance, fake: FakeOidc, admin: Account, user: OidcUser): Promise<LightMyRequestResponse> {
  const t = await call(app, '/api/v1/orgs/current/sso/test', { cookie: admin.cookie, method: 'POST' });
  if (t.statusCode !== 200) throw new Error(`sso test ${t.statusCode} ${t.body}`);
  const beginUrl = (t.json() as { beginUrl: string }).beginUrl;
  const b = await call(app, beginUrl, { cookie: admin.cookie, headers: { 'sec-fetch-site': 'none' } });
  if (b.statusCode !== 302) throw new Error(`test begin ${b.statusCode} ${location(b)}`);
  const q = fake.authorize(location(b), user);
  return call(app, `/api/v1/auth/sso/oidc/${admin.org.id}/callback?${q}`, { cookie: `${bindingCookieOf(b).pair}; ${admin.cookie}` });
}

/** Audit entries of the org of `cookie` with `action` (newest first). */
export async function auditOf(app: FastifyInstance, cookie: string, action: string): Promise<{ action: string; data: Record<string, unknown> }[]> {
  const r = await call(app, `/api/v1/audit?action=${encodeURIComponent(action)}`, { cookie });
  if (r.statusCode !== 200) throw new Error(`audit ${r.statusCode} ${r.body}`);
  return (r.json() as { items: { action: string; data: Record<string, unknown> }[] }).items;
}
