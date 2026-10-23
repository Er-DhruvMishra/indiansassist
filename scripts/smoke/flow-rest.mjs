// REST part of the smoke flow (contracts sections 3.4, 6.4, 6.5, 6.7): discovery, signup, logout + login,
// token creation, client-side token signature check and the public token lookup.

import { randomBytes } from 'node:crypto';
import { check, eq } from './runner.mjs';

const HEX64 = /^[0-9a-f]{64}$/;

/** @param {import('./runner.mjs').Runner} run */
export async function restSteps(run, ctx) {
  const { api, shared, state } = ctx;

  await run.step('GET /api/v1/health', async () => {
    const h = await api.expect('GET', '/api/v1/health');
    check(h.ok === true, 'health.ok is not true');
    check(shared.isRegion(h.region), `health.region ${h.region} is not a region`);
    check(Array.isArray(h.servedRegions), 'health.servedRegions is not an array');
    state.region = h.servedRegions.length > 0 ? h.servedRegions[0] : h.region;
    return `region ${h.region}, node ${h.nodeId}, version ${h.version}`;
  });

  await run.step('GET /.well-known/indiansassist.json', async () => {
    const wk = await api.expect('GET', '/.well-known/indiansassist.json');
    eq(wk.v, 1, 'well-known v');
    check(Array.isArray(wk.keys) && wk.keys.length > 0, 'well-known lists no keys');
    for (const k of wk.keys) {
      eq(k.alg, 'Ed25519', `key ${k.kid} alg`);
      eq(shared.publicKeyEntry(k.pub).kid, k.kid, `kid of key ${k.kid} (first 16 hex of sha256(pub))`);
    }
    state.keys = wk.keys.map((k) => ({ kid: k.kid, pub: k.pub }));
    if (!ctx.cfg.webOrigin) ctx.cfg.webOrigin = new URL(wk.join).origin;
    if (!ctx.cfg.signalUrl) ctx.cfg.signalUrl = wk.signal;
    api.origin = ctx.cfg.webOrigin;
    return `${wk.keys.length} key(s), web origin ${ctx.cfg.webOrigin}, signal ${ctx.cfg.signalUrl}`;
  });

  const suffix = randomBytes(4).toString('hex');
  state.creds = {
    email: `smoke-${suffix}@example.com`,
    password: `Smoke-${randomBytes(12).toString('base64url')}`,
    name: `Smoke Tech ${suffix}`,
  };

  await run.step('POST /api/v1/auth/signup (throwaway org)', async () => {
    const body = { orgName: `Smoke Org ${suffix}`, region: state.region, ...state.creds };
    const r = await api.expect('POST', '/api/v1/auth/signup', body, [201]);
    check(api.cookie, 'signup did not set the ia_session cookie');
    eq(r.user.role, 'org_admin', 'user.role');
    eq(r.org.dataRegion, state.region, 'org.dataRegion');
    eq(r.seat.tier, 'p1_browser', 'seat.tier');
    state.user = r.user;
    state.org = r.org;
    return `org ${r.org.slug} (${r.org.id}) in ${r.org.dataRegion}`;
  });

  await run.step('POST /api/v1/auth/logout then POST /api/v1/auth/login', async () => {
    await api.expect('POST', '/api/v1/auth/logout', undefined, [204]);
    check(api.cookie === null, 'logout did not clear the cookie');
    const me = await api.request('GET', '/api/v1/auth/me');
    eq(me.status, 401, 'GET /auth/me after logout');
    const r = await api.expect('POST', '/api/v1/auth/login', {
      email: state.creds.email,
      password: state.creds.password,
    });
    check(api.cookie, 'login did not set the ia_session cookie');
    eq(r.user.id, state.user.id, 'login user.id');
    const me2 = await api.expect('GET', '/api/v1/auth/me');
    eq(me2.user.id, state.user.id, 'GET /auth/me user.id');
    return `logged in as ${r.user.email}`;
  });

  await run.step('POST /api/v1/tokens (p1_browser, one_time, 15 min)', async () => {
    const r = await api.expect(
      'POST',
      '/api/v1/tokens',
      { tier: 'p1_browser', typ: 'one_time', ttlMinutes: 15, label: 'smoke' },
      [201],
    );
    check(typeof r.compact === 'string' && r.compact.startsWith('ia1.'), 'compact token missing or not ia1.');
    check(/^\d{12}$/.test(r.token.shortCode), `shortCode ${r.token.shortCode} is not 12 digits`);
    eq(r.token.status, 'active', 'token.status');
    check(r.joinUrl.includes('/join#t='), `joinUrl ${r.joinUrl} must carry the token in the fragment`);
    check(!r.joinUrl.includes('?t='), 'joinUrl must not carry the token in the query');
    state.token = r.token;
    state.compact = r.compact;
    return `token ${r.token.id}, code ${r.token.shortCodeDisplay ?? r.token.shortCode}`;
  });

  await run.step('verify token signature client-side (well-known key)', async () => {
    const parsed = shared.parseToken(state.compact);
    check(parsed.ok, 'parseToken: token_malformed');
    const p = parsed.payload;
    eq(p.tid, state.token.id, 'payload.tid');
    eq(p.org, state.org.id, 'payload.org');
    eq(p.by, state.user.id, 'payload.by');
    eq(p.reg, state.region, 'payload.reg');
    eq(p.tier, 'p1_browser', 'payload.tier');
    eq(p.typ, 'one_time', 'payload.typ');
    check(p.exp - p.iat === 15 * 60, `exp - iat = ${p.exp - p.iat}, expected 900`);
    const ok = await shared.verifyTokenSignature(parsed, state.keys);
    check(ok, `Ed25519 signature does not verify with kid ${parsed.kid}`);
    return `kid ${parsed.kid}`;
  });

  await run.step('POST /api/v1/tokens/public-lookup', async () => {
    const r = await api.expect('POST', '/api/v1/tokens/public-lookup', { code: state.compact });
    eq(r.tokenId, state.token.id, 'tokenId');
    eq(r.joinSupported, true, 'joinSupported');
    eq(r.technician?.name, state.user.name, 'technician.name');
    check(!JSON.stringify(r).includes(state.compact), 'PublicToken must never include the compact token');
    check(!JSON.stringify(r).includes(state.token.shortCode), 'PublicToken must never include the short code');
    check(typeof r.signalUrl === 'string' && /^wss?:\/\//.test(r.signalUrl), `signalUrl ${r.signalUrl}`);
    state.deskSignalUrl = ctx.cfg.signalUrlOverride ?? r.signalUrl;
    return `org "${r.org.displayName}", signal ${r.signalUrl}`;
  });
}

/** After the session ended: the one_time token is used (410 token_gone, details.status = used). */
export async function tokenUsedStep(run, ctx) {
  await run.step(
    'public lookup after the session answers 410 token_gone (used)',
    async () => {
      const r = await ctx.api.request('POST', '/api/v1/tokens/public-lookup', { code: ctx.state.compact });
      eq(r.status, 410, 'status');
      eq(r.json?.error?.code, 'token_gone', 'error.code');
      eq(r.json?.error?.details?.status, 'used', 'error.details.status');
    },
    { critical: false },
  );
}

export { HEX64 };
