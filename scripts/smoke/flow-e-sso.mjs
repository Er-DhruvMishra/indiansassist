// Phase E smoke flow, stream sso (docs/specs/phase-e-contracts.md sections 3, 15.2): against a running api, with an
// in-process fake OIDC provider, an in-process SAML IdP and an in-process fake DNS server in this process (127.0.0.1
// only; nothing here reaches the network, and every address is synthetic). OIDC and SAML logins end to end, JIT,
// domain proof, a test sign-in, SSO required, the password refusal and a break-glass login.
//
// The api must run with EGRESS_ALLOW_HTTP=1 and EGRESS_ALLOW_LOOPBACK=1 (section 2.2: tests and local fakes only,
// never with NODE_ENV=production) and SSO_DEV_DNS_SERVERS=127.0.0.1:<SMOKE_SSO_DNS_PORT> (default 5391), the
// development-only seam that points the domain TXT proof of section 3.2b at the fake DNS server below.

import { createHash, createSign, generateKeyPairSync, randomBytes, webcrypto } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { check, eq } from './runner.mjs';

const apiRequire = createRequire(join(dirname(fileURLToPath(import.meta.url)), '../../apps/api/package.json'));
const PASSWORD = 'correct horse battery staple';
const b64u = (b) => Buffer.from(b).toString('base64url');

// ---------- a fake DNS server answering TXT queries ----------

function encodeTxt(id, question, values) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(values ? 0x8180 : 0x8183, 2); // response, RA, NOERROR / NXDOMAIN
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(values ? values.length : 0, 6);
  const answers = (values ?? []).map((v) => {
    const txt = Buffer.from(v, 'utf8');
    const rr = Buffer.alloc(12);
    rr.writeUInt16BE(0xc00c, 0);
    rr.writeUInt16BE(16, 2);
    rr.writeUInt16BE(1, 4);
    rr.writeUInt32BE(30, 6);
    rr.writeUInt16BE(txt.length + 1, 10);
    return Buffer.concat([rr, Buffer.from([txt.length]), txt]);
  });
  return Buffer.concat([header, question, ...answers]);
}

export async function startFakeDns(port) {
  const records = new Map();
  const sock = createSocket('udp4');
  sock.on('message', (msg, rinfo) => {
    try {
      const id = msg.readUInt16BE(0);
      let i = 12;
      const labels = [];
      while (msg[i] !== 0) {
        labels.push(msg.subarray(i + 1, i + 1 + msg[i]).toString('ascii'));
        i += msg[i] + 1;
      }
      const question = msg.subarray(12, i + 5);
      const name = labels.join('.').toLowerCase();
      const type = msg.readUInt16BE(i + 1);
      const values = type === 16 ? records.get(name) : undefined;
      sock.send(encodeTxt(id, question, values ?? null), rinfo.port, rinfo.address);
    } catch {
      /* malformed query: no answer */
    }
  });
  await new Promise((resolve, reject) => {
    sock.once('error', reject);
    sock.bind(port, '127.0.0.1', resolve);
  });
  return { records, close: () => new Promise((r) => sock.close(() => r())) };
}

// ---------- a fake OIDC provider ----------

async function startFakeOidc() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'smoke-1', alg: 'RS256', use: 'sig' };
  const codes = new Map();
  const tokens = new Map();
  const fake = { clientId: 'smoke-client', clientSecret: `smoke-${randomBytes(8).toString('hex')}`, issuer: '' };
  const signJwt = (claims) => {
    const input = `${b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'smoke-1' }))}.${b64u(JSON.stringify(claims))}`;
    return `${input}.${createSign('RSA-SHA256').update(input).sign(privateKey).toString('base64url')}`;
  };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const u = new URL(req.url ?? '/', fake.issuer);
      const send = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (u.pathname === '/.well-known/openid-configuration')
        return send(200, {
          issuer: fake.issuer,
          authorization_endpoint: `${fake.issuer}/authorize`,
          token_endpoint: `${fake.issuer}/token`,
          userinfo_endpoint: `${fake.issuer}/userinfo`,
          jwks_uri: `${fake.issuer}/jwks`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          code_challenge_methods_supported: ['S256'],
        });
      if (u.pathname === '/jwks') return send(200, { keys: [jwk] });
      if (u.pathname === '/token' && req.method === 'POST') {
        const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
        const rec = codes.get(form.get('code') ?? '');
        codes.delete(form.get('code') ?? '');
        const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? '');
        const [id, secret] = basic ? Buffer.from(basic[1], 'base64').toString('utf8').split(':').map(decodeURIComponent) : [];
        if (!rec || id !== fake.clientId || secret !== fake.clientSecret) return send(400, { error: 'invalid_grant' });
        if (createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') !== rec.challenge) return send(400, { error: 'invalid_grant' });
        if (form.get('redirect_uri') !== rec.redirectUri) return send(400, { error: 'invalid_grant' });
        const now = Math.floor(Date.now() / 1000);
        const at = randomBytes(16).toString('hex');
        tokens.set(at, rec.user);
        return send(200, {
          access_token: at,
          token_type: 'Bearer',
          expires_in: 300,
          id_token: signJwt({ iss: fake.issuer, aud: fake.clientId, iat: now, exp: now + 300, nonce: rec.nonce, ...rec.user }),
        });
      }
      if (u.pathname === '/userinfo') {
        const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
        const user = m ? tokens.get(m[1]) : null;
        return user ? send(200, user) : send(401, { error: 'invalid_token' });
      }
      return send(404, { error: 'not_found' });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.issuer = `http://127.0.0.1:${server.address().port}`;
  /** What the authorization endpoint would answer for `user`: the callback query. */
  fake.authorize = (authUrl, user) => {
    const p = new URL(authUrl).searchParams;
    check(p.get('code_challenge_method') === 'S256', 'PKCE S256 expected');
    const code = randomBytes(12).toString('hex');
    codes.set(code, { user, challenge: p.get('code_challenge'), redirectUri: p.get('redirect_uri'), nonce: p.get('nonce') });
    return new URLSearchParams({ code, state: p.get('state') ?? '', iss: fake.issuer });
  };
  fake.close = () =>
    new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  return fake;
}

// ---------- a SAML IdP (xml-crypto from the api's dev dependencies) ----------

function installReflectShim() {
  if (typeof Reflect.getMetadata === 'function') return;
  const store = new WeakMap();
  const own = (t, p, create) => {
    let m = store.get(t);
    if (!m && create) store.set(t, (m = new Map()));
    let x = m?.get(p);
    if (!x && create) m.set(p, (x = new Map()));
    return x;
  };
  Reflect.defineMetadata = (k, v, t, p) => own(t, p, true).set(k, v);
  Reflect.getOwnMetadata = (k, t, p) => own(t, p, false)?.get(k);
  Reflect.hasOwnMetadata = (k, t, p) => own(t, p, false)?.has(k) ?? false;
  Reflect.getMetadata = (k, t, p) => {
    for (let o = t; o; o = Object.getPrototypeOf(o)) if (own(o, p, false)?.has(k)) return own(o, p, false).get(k);
    return undefined;
  };
  Reflect.hasMetadata = (k, t, p) => Reflect.getMetadata(k, t, p) !== undefined;
}

export async function makeSamlIdp() {
  installReflectShim();
  const x509 = await import(pathToFileURL(apiRequire.resolve('@peculiar/x509')).href);
  x509.cryptoProvider.set(webcrypto);
  const alg = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) };
  const keys = await webcrypto.subtle.generateKey(alg, true, ['sign', 'verify']);
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: '01',
    name: 'CN=smoke-idp.example.test',
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 86_400_000),
    signingAlgorithm: alg,
    keys,
  });
  const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey)).toString('base64');
  const privateKeyPem = `-----BEGIN PRIVATE KEY-----\n${pkcs8.match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----\n`;
  return { entityId: 'https://smoke-idp.example.test/saml', certPem: cert.toString('pem'), privateKeyPem };
}

export function samlResponseFor(idp, { acsUrl, audience, inResponseTo, nameId }) {
  const { SignedXml } = apiRequire('xml-crypto');
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const aid = `_a${randomBytes(12).toString('hex')}`;
  let assertion =
    `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${aid}" Version="2.0" IssueInstant="${iso(now)}">` +
    `<saml:Issuer>${idp.entityId}</saml:Issuer>` +
    `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${nameId}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData NotOnOrAfter="${iso(now + 300_000)}" Recipient="${acsUrl}" InResponseTo="${inResponseTo}"/></saml:SubjectConfirmation></saml:Subject>` +
    `<saml:Conditions NotBefore="${iso(now - 60_000)}" NotOnOrAfter="${iso(now + 300_000)}"><saml:AudienceRestriction><saml:Audience>${audience}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${iso(now)}" SessionIndex="_s1"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
    `</saml:Assertion>`;
  const sig = new SignedXml({
    privateKey: idp.privateKeyPem,
    signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
    canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
  });
  sig.addReference({
    xpath: "//*[local-name(.)='Assertion']",
    digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
    transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'],
  });
  sig.computeSignature(assertion, { location: { reference: "//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']", action: 'after' } });
  assertion = sig.getSignedXml();
  const xml =
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r${randomBytes(8).toString('hex')}" Version="2.0" IssueInstant="${iso(now)}" Destination="${acsUrl}" InResponseTo="${inResponseTo}">` +
    `<saml:Issuer>${idp.entityId}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>${assertion}</samlp:Response>`;
  return Buffer.from(xml, 'utf8').toString('base64');
}

// ---------- http helpers (explicit cookies, manual redirects) ----------

function cookiesOf(res) {
  return typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
}
const pairOf = (line) => line.split(';')[0];

async function rest(apiUrl, method, path, { cookie, body, headers } = {}) {
  const h = { Accept: 'application/json', ...(headers ?? {}) };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (!['GET', 'HEAD'].includes(method)) h['X-Requested-With'] = 'IndiansAssist';
  if (cookie) h.Cookie = cookie;
  const res = await fetch(apiUrl + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, json, text, location: res.headers.get('location') ?? '', cookies: cookiesOf(res) };
}

const sessionPair = (r) => {
  const line = r.cookies.find((c) => c.startsWith('ia_session='));
  return line ? pairOf(line) : null;
};
const bindingPair = (r) => {
  const line = r.cookies.find((c) => c.startsWith('ia_sso_'));
  check(line, `no binding cookie (status ${r.status} ${r.location})`);
  return pairOf(line);
};
const ssoError = (r) => (r.location.includes('sso_error=') ? new URL(r.location).searchParams.get('sso_error') : null);

// ---------- the flow ----------

export async function flowSteps(run, ctx) {
  const apiUrl = ctx.cfg.apiUrl;
  const dnsPort = Number(process.env.SMOKE_SSO_DNS_PORT || 5391);
  const tag = randomBytes(4).toString('hex');
  const domain = `sso-${tag}.example.test`;
  const samlDomain = `saml-${tag}.example.test`;
  const s = {};
  let dns = null;
  let oidc = null;
  try {
    await run.step('sso: fakes up (OIDC provider, SAML IdP, DNS on 127.0.0.1)', async () => {
      dns = await startFakeDns(dnsPort);
      oidc = await startFakeOidc();
      s.idp = await makeSamlIdp();
      return `dns :${dnsPort}, oidc ${oidc.issuer}`;
    });

    await run.step('sso: org_admin signs up (synthetic address on the org domain)', async () => {
      const r = await rest(apiUrl, 'POST', '/api/v1/auth/signup', {
        body: { orgName: `SSO Smoke ${tag}`, name: 'Sso Admin', email: `admin@${domain}`, password: PASSWORD },
      });
      eq(r.status, 201, 'signup');
      s.admin = { cookie: sessionPair(r), id: r.json.user.id, org: r.json.org };
    });

    await run.step('sso: OIDC configured (discovery through the egress guard, secret sealed)', async () => {
      const r = await rest(apiUrl, 'PUT', '/api/v1/orgs/current/sso', {
        cookie: s.admin.cookie,
        body: {
          config: {
            v: 1,
            protocol: 'oidc',
            enabled: true,
            displayName: 'Smoke IdP',
            oidc: {
              issuer: oidc.issuer,
              clientId: oidc.clientId,
              tokenEndpointAuth: 'client_secret_basic',
              scopes: ['openid', 'email', 'profile'],
              emailClaim: 'email',
              nameClaim: 'name',
              groupsClaim: null,
              requiredClaims: [],
            },
            saml: null,
            jit: { enabled: true, defaultRole: 'technician', defaultSeatTier: 'p1_browser', groupRoles: [] },
            sessionMaxAgeHours: 12,
          },
          clientSecret: oidc.clientSecret,
        },
      });
      if (r.status === 400 && r.json?.error?.code === 'egress_refused')
        throw new Error('egress_refused: start the api with EGRESS_ALLOW_HTTP=1 EGRESS_ALLOW_LOOPBACK=1');
      eq(r.status, 200, `PUT /orgs/current/sso ${r.text.slice(0, 200)}`);
      eq(r.json.secrets.clientSecret.set, true, 'secret status');
      check(!r.text.includes(oidc.clientSecret), 'the secret is never returned');
    });

    await run.step('sso: domain proven by DNS TXT', async () => {
      const add = await rest(apiUrl, 'POST', '/api/v1/orgs/current/sso/domains', { cookie: s.admin.cookie, body: { domain } });
      eq(add.status, 201, 'add domain');
      dns.records.set(add.json.txtName, [add.json.txtValue]);
      const v = await rest(apiUrl, 'POST', `/api/v1/orgs/current/sso/domains/${add.json.id}/verify`, { cookie: s.admin.cookie });
      if (v.status === 409 && v.json?.error?.code === 'domain_unverified')
        throw new Error(`domain_unverified: start the api with SSO_DEV_DNS_SERVERS=127.0.0.1:${dnsPort} (non-production, loopback egress on)`);
      eq(v.status, 200, 'verify');
      eq(v.json.status, 'verified', 'domain status');
      s.domainId = add.json.id;
    });

    await run.step('sso: discovery routes the domain to the IdP', async () => {
      const r = await rest(apiUrl, 'POST', '/api/v1/auth/sso/discover', { body: { email: `someone@${domain}` } });
      eq(r.status, 200, 'discover');
      eq(r.json.mode, 'sso_available', 'mode');
      eq(r.json.displayName, 'Smoke IdP', 'displayName');
    });

    const oidcLogin = async (user, cookie) => {
      const b = await rest(apiUrl, 'GET', `/api/v1/auth/sso/${s.admin.org.slug}/begin`, { cookie, headers: { 'Sec-Fetch-Site': 'none' } });
      eq(b.status, 302, `begin ${b.location}`);
      const q = oidc.authorize(b.location, user);
      return rest(apiUrl, 'GET', `/api/v1/auth/sso/oidc/${s.admin.org.id}/callback?${q}`, { cookie: [bindingPair(b), cookie].filter(Boolean).join('; ') });
    };

    await run.step('sso: a cross-site begin lands on the /sso/continue interstitial', async () => {
      const r = await rest(apiUrl, 'GET', `/api/v1/auth/sso/${s.admin.org.slug}/begin`, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
      eq(r.status, 303, 'status');
      check(new URL(r.location).pathname === '/sso/continue', `went to ${r.location}`);
    });

    await run.step('sso: OIDC login (PKCE, per-org callback) provisions a JIT technician', async () => {
      const r = await oidcLogin({ sub: `jit-${tag}`, email: `newtech@${domain}`, email_verified: true, name: 'New Tech' });
      eq(ssoError(r), null, 'sso_error');
      eq(r.status, 303, 'status');
      const cookie = sessionPair(r);
      check(cookie, 'session cookie');
      const me = await rest(apiUrl, 'GET', '/api/v1/auth/me', { cookie });
      eq(me.status, 200, 'me');
      eq(me.json.user.role, 'technician', 'role');
      eq(me.json.user.email, `newtech@${domain}`, 'email');
    });

    await run.step('sso: a password technician exists before SSO is required', async () => {
      const inv = await rest(apiUrl, 'POST', '/api/v1/users/invite', { cookie: s.admin.cookie, body: { email: `pwtech@${domain}`, name: 'Pw Tech', role: 'technician' } });
      eq(inv.status, 201, 'invite');
      const invite = new URL(inv.json.inviteUrl).hash.replace('#i=', '');
      const acc = await rest(apiUrl, 'POST', '/api/v1/auth/accept-invite', { body: { invite, name: 'Pw Tech', password: PASSWORD } });
      eq(acc.status, 200, 'accept');
      s.techCookie = sessionPair(acc);
    });

    await run.step('sso: test sign-in as the admin (read-only, matchedSelf)', async () => {
      const t = await rest(apiUrl, 'POST', '/api/v1/orgs/current/sso/test', { cookie: s.admin.cookie });
      eq(t.status, 200, 'test');
      const b = await rest(apiUrl, 'GET', t.json.beginUrl, { cookie: s.admin.cookie, headers: { 'Sec-Fetch-Site': 'none' } });
      eq(b.status, 302, `test begin ${b.location}`);
      const q = oidc.authorize(b.location, { sub: `admin-${tag}`, email: `admin@${domain}`, email_verified: true });
      const cb = await rest(apiUrl, 'GET', `/api/v1/auth/sso/oidc/${s.admin.org.id}/callback?${q}`, { cookie: `${bindingPair(b)}; ${s.admin.cookie}` });
      check(cb.location.endsWith('/app/settings/sso?test=ok'), `test result ${cb.location}`);
      eq(sessionPair(cb), null, 'no session from a test');
      const st = await rest(apiUrl, 'GET', '/api/v1/orgs/current/sso', { cookie: s.admin.cookie });
      eq(st.json.lastTest.matchedSelf, true, 'matchedSelf');
    });

    await run.step('sso: SSO required (break-glass admin, dry run warning, then on)', async () => {
      const bg = await rest(apiUrl, 'PUT', '/api/v1/orgs/current/sso/break-glass', { cookie: s.admin.cookie, body: { userIds: [s.admin.id] } });
      eq(bg.status, 200, 'break-glass');
      const dry = await rest(apiUrl, 'PATCH', '/api/v1/orgs/current/sso/required', { cookie: s.admin.cookie, body: { required: true, dryRun: true } });
      eq(dry.status, 200, `dry run ${dry.text.slice(0, 200)}`);
      eq(dry.json.required, false, 'dry run changes nothing');
      check(typeof dry.json.warnings.usersOutsideVerifiedDomains === 'number', 'warning count');
      const on = await rest(apiUrl, 'PATCH', '/api/v1/orgs/current/sso/required', { cookie: s.admin.cookie, body: { required: true } });
      eq(on.status, 200, 'required on');
      eq(on.json.required, true, 'required');
    });

    await run.step('sso: password sessions revoked; password login answers sso_required after the password', async () => {
      eq((await rest(apiUrl, 'GET', '/api/v1/auth/me', { cookie: s.techCookie })).status, 401, 'revoked session');
      const wrong = await rest(apiUrl, 'POST', '/api/v1/auth/login', { body: { email: `pwtech@${domain}`, password: 'not the password' } });
      eq(wrong.status, 401, 'wrong password');
      const right = await rest(apiUrl, 'POST', '/api/v1/auth/login', { body: { email: `pwtech@${domain}`, password: PASSWORD } });
      eq(right.status, 403, 'sso_required');
      eq(right.json.error.code, 'sso_required', 'code');
      check(String(right.json.error.details.beginUrl).startsWith(`/api/v1/auth/sso/${s.admin.org.slug}/begin`), 'beginUrl');
    });

    await run.step('sso: break-glass password login gets a 1 h session', async () => {
      const r = await rest(apiUrl, 'POST', '/api/v1/auth/login', { body: { email: `admin@${domain}`, password: PASSWORD } });
      eq(r.status, 200, 'break-glass login');
      const line = r.cookies.find((c) => c.startsWith('ia_session='));
      check(/Max-Age=3600/i.test(line ?? ''), 'Max-Age=3600');
      s.admin.cookie = pairOf(line);
      const audit = await rest(apiUrl, 'GET', '/api/v1/audit?action=auth.break_glass_used', { cookie: s.admin.cookie });
      eq(audit.json.items[0]?.data?.userId, s.admin.id, 'chained');
    });

    await run.step('sso: the SSO user still signs in while required', async () => {
      const r = await oidcLogin({ sub: `jit-${tag}`, email: `newtech@${domain}`, email_verified: true });
      eq(ssoError(r), null, 'sso_error');
      check(sessionPair(r), 'session');
    });

    await run.step('sso: SSO required off again (revokes nothing)', async () => {
      const off = await rest(apiUrl, 'PATCH', '/api/v1/orgs/current/sso/required', { cookie: s.admin.cookie, body: { required: false } });
      eq(off.status, 200, 'off');
      eq(off.json.required, false, 'required');
    });

    await run.step('sso: SAML org configured, its domain proven, metadata served', async () => {
      const r = await rest(apiUrl, 'POST', '/api/v1/auth/signup', {
        body: { orgName: `SAML Smoke ${tag}`, name: 'Saml Admin', email: `admin@${samlDomain}`, password: PASSWORD },
      });
      eq(r.status, 201, 'signup');
      s.saml = { cookie: sessionPair(r), org: r.json.org };
      const put = await rest(apiUrl, 'PUT', '/api/v1/orgs/current/sso', {
        cookie: s.saml.cookie,
        body: {
          config: {
            v: 1,
            protocol: 'saml',
            enabled: true,
            displayName: 'Smoke SAML',
            oidc: null,
            saml: {
              idpEntityId: s.idp.entityId,
              ssoUrl: 'http://127.0.0.1:9/sso',
              idpCertificates: [s.idp.certPem],
              nameIdFormat: 'email',
              emailAttribute: null,
              nameAttribute: null,
              groupsAttribute: null,
              signAuthnRequests: false,
              wantResponseSigned: false,
              clockSkewSec: 120,
            },
            jit: { enabled: true, defaultRole: 'technician', defaultSeatTier: 'p1_browser', groupRoles: [] },
            sessionMaxAgeHours: 8,
          },
        },
      });
      eq(put.status, 200, `PUT saml ${put.text.slice(0, 200)}`);
      s.saml.acs = put.json.sp.acsUrl;
      s.saml.entityId = put.json.sp.entityId;
      const add = await rest(apiUrl, 'POST', '/api/v1/orgs/current/sso/domains', { cookie: s.saml.cookie, body: { domain: samlDomain } });
      dns.records.set(add.json.txtName, [add.json.txtValue]);
      eq((await rest(apiUrl, 'POST', `/api/v1/orgs/current/sso/domains/${add.json.id}/verify`, { cookie: s.saml.cookie })).status, 200, 'verify');
      const md = await rest(apiUrl, 'GET', `/api/v1/auth/sso/saml/${s.saml.org.id}/metadata`);
      eq(md.status, 200, 'metadata');
      check(md.text.includes(s.saml.acs), 'ACS in metadata');
    });

    await run.step('sso: SAML login (signed assertion, our checks, CSRF-exempt ACS) provisions a JIT user', async () => {
      const b = await rest(apiUrl, 'GET', `/api/v1/auth/sso/${s.saml.org.slug}/begin`, { headers: { 'Sec-Fetch-Site': 'none' } });
      eq(b.status, 302, `begin ${b.location}`);
      const u = new URL(b.location);
      const relayState = u.searchParams.get('RelayState');
      const reqXml = inflateRawSync(Buffer.from(u.searchParams.get('SAMLRequest'), 'base64')).toString('utf8');
      const requestId = /ID="([^"]+)"/.exec(reqXml)[1];
      const resp = samlResponseFor(s.idp, { acsUrl: s.saml.acs, audience: s.saml.entityId, inResponseTo: requestId, nameId: `samluser@${samlDomain}` });
      const form = new URLSearchParams({ SAMLResponse: resp, RelayState: relayState }).toString();
      const res = await fetch(s.saml.acs, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingPair(b), Origin: 'https://smoke-idp.example.test' },
        body: form,
        redirect: 'manual',
      });
      const r = { status: res.status, location: res.headers.get('location') ?? '', cookies: cookiesOf(res) };
      eq(ssoError(r), null, `sso_error (${r.location})`);
      eq(r.status, 303, 'status');
      const me = await rest(apiUrl, 'GET', '/api/v1/auth/me', { cookie: sessionPair(r) });
      eq(me.json.user.email, `samluser@${samlDomain}`, 'saml user');
      // a straight replay of the same POST is refused: the flow was consumed
      const again = await fetch(s.saml.acs, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: bindingPair(b) },
        body: form,
        redirect: 'manual',
      });
      check((again.headers.get('location') ?? '').includes('sso_error=flow_expired'), 'replay refused');
    });
  } finally {
    await oidc?.close();
    await dns?.close();
  }
}
