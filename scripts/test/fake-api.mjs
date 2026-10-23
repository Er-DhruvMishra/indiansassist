// In-process fake of the IndiansAssist api, just enough of contracts sections 3, 5, 6 and 7 to drive
// scripts/smoke.mjs in tests (the real api is built elsewhere and needs no Docker). Tokens, audit hashes,
// checkpoints and the JSONL export use @indiansassist/shared, so a PASS here means the smoke client speaks the
// same wire format as the shared contract code. `faults` injects specific contract violations.

import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { attachSignal } from './fake-signal.mjs';

export const WEB_ORIGIN = 'http://localhost:5173';
const SEED = 'a'.repeat(64);

/**
 * @param {object} shared  loaded @indiansassist/shared module
 * @param {{ tamperAudit?: boolean, leakOfferBeforeConsent?: boolean, skipCsrf?: boolean }} [faults]
 */
export async function startFakeApi(shared, faults = {}) {
  const pub = await shared.publicKeyFromSeed(SEED);
  const key = { kid: shared.kidOf(pub), pub: shared.publicKeyToBase64url(pub) };
  const st = {
    users: [],
    orgs: new Map(),
    tokens: new Map(),
    sessions: new Map(),
    cookies: new Map(),
    chains: new Map(),
  };

  const audit = (orgId, fields) => {
    const chain = st.chains.get(orgId) ?? [];
    const tail = chain.at(-1) ?? null;
    const e = shared.appendEntry(tail, {
      reason: null,
      session_id: null,
      data: {},
      region: 'in-mum',
      ...fields,
      org_id: orgId,
      ts: new Date().toISOString(),
    });
    e.id = randomUUID();
    chain.push(e);
    st.chains.set(orgId, chain);
    return e;
  };
  const toWire = (e) => ({
    id: e.id,
    seq: e.seq,
    sessionId: e.session_id,
    actor: e.actor,
    action: e.action,
    reason: e.reason,
    region: e.region,
    ts: e.ts,
    data: e.data,
    prevHash: e.prev_hash,
    hash: e.hash,
  });
  const anchor = async (orgId) => {
    const tail = st.chains.get(orgId).at(-1);
    const c = { org_id: orgId, seq: tail.seq, tail: tail.hash, ts: new Date().toISOString() };
    const sig = await shared.signCheckpoint(c, SEED);
    audit(orgId, {
      action: 'audit.anchored',
      actor: { id: null, label: 'system', type: 'system' },
      data: { seq: c.seq, tail: c.tail, ts: c.ts, kid: key.kid, sig },
    });
  };
  const userOf = (req) => {
    const m = /ia_session=([^;]+)/.exec(req.headers.cookie ?? '');
    return m ? (st.cookies.get(m[1]) ?? null) : null;
  };
  const login = (res, user) => {
    const v = randomBytes(16).toString('hex');
    st.cookies.set(v, user);
    res.setHeader('Set-Cookie', `ia_session=${v}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`);
  };
  const ctx = { st, shared, key, faults, audit, userOf, WEB_ORIGIN };

  const routes = {
    'GET /api/v1/health': () => [
      200,
      {
        ok: true,
        region: 'in-mum',
        servedRegions: [],
        nodeId: 'fake:1',
        version: '0.0.0',
        time: new Date().toISOString(),
      },
    ],
    'GET /.well-known/indiansassist.json': () => [
      200,
      {
        v: 1,
        region: 'in-mum',
        keys: [{ ...key, alg: 'Ed25519', createdAt: new Date().toISOString() }],
        api: `${ctx.base}/api/v1`,
        signal: `${ctx.base.replace(/^http/, 'ws')}/signal`,
        join: `${WEB_ORIGIN}/join`,
      },
    ],
    'POST /api/v1/auth/signup': (req, res, body) => {
      const org = {
        id: randomUUID(),
        name: body.orgName,
        slug: body.orgName.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        dataRegion: body.region ?? 'in-mum',
        planTier: 'p1_browser',
        branding: {},
        createdAt: new Date().toISOString(),
      };
      const user = {
        id: randomUUID(),
        orgId: org.id,
        email: body.email,
        name: body.name,
        role: 'org_admin',
        status: 'active',
        password: body.password,
      };
      st.orgs.set(org.id, org);
      st.users.push(user);
      audit(org.id, {
        action: 'auth.signup',
        actor: { id: user.id, label: user.name, type: 'user' },
        data: { emailHash: shared.sha256Hex(body.email) },
      });
      login(res, user);
      return [
        201,
        { user: pubUser(user), org, seat: { id: randomUUID(), userId: user.id, tier: 'p1_browser', active: true } },
      ];
    },
    'POST /api/v1/auth/logout': (req, res, _b, user) => {
      for (const [k, u] of st.cookies) if (u === user) st.cookies.delete(k);
      res.setHeader('Set-Cookie', 'ia_session=; Path=/; Max-Age=0');
      audit(user.orgId, { action: 'auth.logout', actor: { id: user.id, label: user.name, type: 'user' } });
      return [204, null];
    },
    'POST /api/v1/auth/login': (req, res, body) => {
      const user = st.users.find((u) => u.email === body.email && u.password === body.password);
      if (!user) return [401, err('invalid_credentials')];
      login(res, user);
      audit(user.orgId, {
        action: 'auth.login',
        actor: { id: user.id, label: user.name, type: 'user' },
        data: { method: 'local' },
      });
      return [200, { user: pubUser(user), org: st.orgs.get(user.orgId), seat: null }];
    },
    'GET /api/v1/auth/me': (_q, _r, _b, user) => [
      200,
      { user: pubUser(user), org: st.orgs.get(user.orgId), seat: null },
    ],
    'POST /api/v1/tokens': async (_q, _r, body, user) => {
      const now = Math.floor(Date.now() / 1000);
      const id = randomUUID();
      const signed = await shared.signToken(
        {
          tid: id,
          org: user.orgId,
          by: user.id,
          tier: body.tier,
          typ: body.typ,
          reg: 'in-mum',
          iat: now,
          exp: now + body.ttlMinutes * 60,
        },
        SEED,
      );
      const shortCode = String(100000000000 + Math.floor(Math.random() * 8e11));
      const token = {
        id,
        tier: body.tier,
        typ: body.typ,
        status: 'active',
        shortCode,
        shortCodeDisplay: shortCode.replace(/(\d{4})(\d{4})(\d{4})/, '$1 $2 $3'),
        label: body.label ?? null,
        region: 'in-mum',
        createdBy: { id: user.id, name: user.name },
        compact: signed.compact,
        orgId: user.orgId,
      };
      st.tokens.set(id, token);
      audit(user.orgId, {
        action: 'token.created',
        actor: { id: user.id, label: user.name, type: 'user' },
        data: {
          tokenId: id,
          tier: body.tier,
          typ: body.typ,
          expiresAt: new Date((now + body.ttlMinutes * 60) * 1000).toISOString(),
        },
      });
      const joinUrl = `${WEB_ORIGIN}/join#t=${signed.compact}`;
      const { compact: _c, orgId: _o, ...wire } = token;
      return [201, { token: { ...wire, joinUrl }, compact: signed.compact, joinUrl }];
    },
    'POST /api/v1/tokens/public-lookup': (_q, _r, body) => {
      const token = [...st.tokens.values()].find((t) => t.compact === body.code);
      if (!token) return [404, err('token_not_found')];
      if (token.status !== 'active') return [410, err('token_gone', { status: token.status })];
      const org = st.orgs.get(token.orgId);
      return [
        200,
        {
          tokenId: token.id,
          tier: token.tier,
          typ: token.typ,
          expiresAt: new Date().toISOString(),
          region: 'in-mum',
          org: { displayName: org.name, logoData: null, accentColor: null, supportEmail: null },
          technician: { name: token.createdBy.name },
          signalUrl: `${ctx.base.replace(/^http/, 'ws')}/signal`,
          joinSupported: true,
        },
      ];
    },
    'POST /api/v1/audit/export': async (_q, res, _b, user) => {
      await anchor(user.orgId);
      const entries = st.chains.get(user.orgId);
      const header = {
        ia_audit_export: 1,
        orgId: user.orgId,
        orgSlug: st.orgs.get(user.orgId).slug,
        region: 'in-mum',
        exportedAt: new Date().toISOString(),
        startSeq: 1,
        startPrevHash: shared.GENESIS_HASH,
        count: entries.length,
        keys: [key],
      };
      res.setHeader('Content-Type', 'application/x-ndjson');
      return [
        200,
        shared.buildAuditJsonl(
          header,
          entries.map(({ id, ...e }) => ({ id, ...e })),
        ),
      ];
    },
    'POST /api/v1/audit/verify': (_q, _r, _b, user) => {
      const r = shared.verifyChain(st.chains.get(user.orgId), { orgId: user.orgId, region: 'in-mum', pubKeys: [key] });
      return [200, { ...r, verifiedAt: new Date().toISOString() }];
    },
  };
  const sessionAudit = (sid, user) => {
    const items = st.chains
      .get(user.orgId)
      .filter((e) => e.session_id === sid)
      .map(toWire);
    if (faults.tamperAudit && items.length > 1)
      items[1] = { ...items[1], data: { ...items[1].data, tokenId: randomUUID() } };
    return [
      200,
      { items, integrity: { ok: true, checked: items.length, verifiedAt: new Date().toISOString() }, files: [] },
    ];
  };

  const server = createServer(async (req, res) => {
    const path = req.url.split('?')[0];
    let body = '';
    for await (const chunk of req) body += chunk;
    const json = body ? JSON.parse(body) : {};
    const send = ([status, payload]) => {
      if (payload === null) return res.writeHead(status).end();
      if (typeof payload === 'string') return res.writeHead(status).end(payload);
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(payload));
    };
    try {
      if (req.method !== 'GET' && !faults.skipCsrf) {
        const origin = req.headers.origin;
        if (req.headers['x-requested-with'] !== 'IndiansAssist' || (origin && origin !== WEB_ORIGIN))
          return send([403, err('csrf_failed')]);
      }
      const user = userOf(req);
      const m = /^\/api\/v1\/sessions\/([0-9a-f-]+)\/audit$/.exec(path);
      const handler = m ? () => sessionAudit(m[1], user) : routes[`${req.method} ${path}`];
      if (!handler) return send([404, err('not_found')]);
      const open = [
        '/api/v1/health',
        '/.well-known/indiansassist.json',
        '/api/v1/auth/signup',
        '/api/v1/auth/login',
        '/api/v1/tokens/public-lookup',
      ];
      if (!open.includes(path) && !user) return send([401, err('unauthenticated')]);
      send(await handler(req, res, json, user));
    } catch (e) {
      send([500, err('internal', { message: String(e) })]);
    }
  });
  attachSignal(server, ctx);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  ctx.base = `http://127.0.0.1:${server.address().port}`;
  return {
    url: ctx.base,
    state: st,
    close: () =>
      new Promise((r) => {
        ctx.wss?.close();
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

const pubUser = ({ password: _p, ...u }) => ({ ...u, createdAt: new Date().toISOString(), lastLoginAt: null });
const err = (code, details) => ({ error: { code, message: code, ...(details ? { details } : {}) } });
