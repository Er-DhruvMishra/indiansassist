// Phase E smoke flow, stream tickets (docs/specs/phase-e-contracts.md sections 4, 15.3): against a running api, with
// an in-process fake Jira and an in-process webhook receiver in this process (plain http on 127.0.0.1; nothing here
// reaches the network). Configures both, tests both, ends a real P1 session over /signal, pushes a manual note to
// Jira and to the webhook (the receiver verifies the HMAC signature), pushes the session's AI summary when one is
// ready (otherwise proves the honest `409 summary_not_ready`), has a 429 retried by the sweeper, and an ambiguous 500
// left failed and never retried.
//
// The api must run with EGRESS_ALLOW_HTTP=1 and EGRESS_ALLOW_LOOPBACK=1 (section 2.2: only tests and local fakes set
// them, never with NODE_ENV=production); without them the first configuration step fails with egress_refused.

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { check, eq } from './runner.mjs';
import { SignalClient } from './ws-client.mjs';

/** A recording fake: every request is kept; `script` overrides the next answers. */
async function startFake(name, route) {
  const fake = { name, requests: [], queue: [], url: '' };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      let json = null;
      try {
        json = raw.length ? JSON.parse(raw.toString('utf8')) : null;
      } catch {
        json = null;
      }
      const u = new URL(req.url ?? '/', 'http://fake.test');
      const rec = { method: req.method, path: u.pathname, headers: req.headers, raw, json };
      fake.requests.push(rec);
      const a = fake.queue.shift() ?? route(rec);
      res.writeHead(a.status, { 'content-type': 'application/json', ...(a.headers ?? {}) });
      res.end(a.json === undefined ? '' : JSON.stringify(a.json));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.url = `http://127.0.0.1:${server.address().port}`;
  fake.close = () =>
    new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  fake.script = (...a) => fake.queue.push(...a);
  return fake;
}

/** Receiver-side check of section 4.5 (the snippet the integrations page shows). */
function verifySignature(secret, header, ts, raw) {
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const mac = createHmac('sha256', Buffer.from(secret, 'base64url')).update(`${ts}.`).update(raw).digest('hex');
  return String(header)
    .split(',')
    .map((s) => s.trim())
    .some((v) => v.startsWith('v1=') && v.length === 67 && timingSafeEqual(Buffer.from(v.slice(3)), Buffer.from(mac)));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @param {import('./runner.mjs').Runner} run */
export async function flowSteps(run, ctx) {
  const { api, cfg, state } = ctx;
  const T = cfg.timeoutMs;
  const fakes = [];
  const suffix = randomBytes(4).toString('hex');
  try {
    await run.step('tickets: discovery and a throwaway org', async () => {
      const h = await api.expect('GET', '/api/v1/health');
      const wk = await api.expect('GET', '/.well-known/indiansassist.json');
      cfg.webOrigin ??= new URL(wk.join).origin;
      cfg.signalUrl ??= wk.signal;
      api.origin = cfg.webOrigin;
      const region = h.servedRegions?.length ? h.servedRegions[0] : h.region;
      const r = await api.expect(
        'POST',
        '/api/v1/auth/signup',
        { orgName: `Smoke Tickets ${suffix}`, region, name: `Smoke Admin ${suffix}`, email: `smoke-tickets-${suffix}@example.com`, password: `Smoke-${randomBytes(12).toString('base64url')}` },
        [201],
      );
      state.user = r.user;
      state.org = r.org;
      return `org ${r.org.slug}`;
    });

    await run.step('tickets: start the in-process fake Jira and webhook receiver', async () => {
      state.jira = await startFake('jira', (r) => {
        if (r.method === 'GET' && r.path === '/rest/api/3/myself') return { status: 200, json: { displayName: 'Smoke Bot' } };
        if (r.method === 'POST' && r.path === '/rest/api/3/issue') return { status: 201, json: { id: '10001', key: `OPS-${state.jira.requests.length}` } };
        if (r.method === 'POST' && /^\/rest\/api\/3\/issue\/[^/]+\/comment$/.test(r.path)) return { status: 201, json: { id: '1' } };
        return { status: 404, json: { errorMessages: ['no route'] } };
      });
      fakes.push(state.jira);
      state.hook = await startFake('webhook', () => ({ status: 200, json: { externalId: `HOOK-${state.hook.requests.length}` } }));
      fakes.push(state.hook);
      return `jira ${state.jira.url}, webhook ${state.hook.url}`;
    });

    await run.step('PUT /api/v1/integrations/jira (credentials write-only) + test', async () => {
      const r = await api.request('PUT', '/api/v1/integrations/jira', {
        enabled: true,
        config: { siteUrl: state.jira.url, deployment: 'cloud', projectKey: 'OPS', issueType: 'Task', labels: ['smoke'] },
        credentials: { email: 'bot@example.com', apiToken: `smoke-${suffix}` },
      });
      if (r.status === 400 && r.json?.error?.code === 'egress_refused')
        throw new Error('egress_refused: start the api with EGRESS_ALLOW_HTTP=1 and EGRESS_ALLOW_LOOPBACK=1 for the local fakes');
      eq(r.status, 200, 'PUT status');
      check(r.json.credentials.set === true && /^[0-9a-f]{8}$/.test(r.json.credentials.fingerprint), 'credentials are not a SecretStatus');
      check(!r.text.includes(`smoke-${suffix}`), 'the API token was echoed');
      const t = await api.expect('POST', '/api/v1/integrations/jira/test', {});
      eq(t.ok, true, 'test ok');
      eq(t.account, 'Smoke Bot', 'test account');
      return 'configured and tested';
    });

    await run.step('PUT /api/v1/integrations/webhook (secret shown once) + signed ping', async () => {
      const r = await api.expect('PUT', '/api/v1/integrations/webhook', { enabled: true, config: { url: `${state.hook.url}/hooks/smoke-path?token=q` } }, [201]);
      check(/^[A-Za-z0-9_-]{43}$/.test(r.secret), 'no 43-character secret');
      eq(r.integration.config.pathSet, true, 'config.pathSet');
      check(!JSON.stringify(r.integration).includes('smoke-path'), 'the webhook path was returned');
      state.secret = r.secret;
      const t = await api.expect('POST', '/api/v1/integrations/webhook/test', {});
      eq(t.ok, true, 'ping ok');
      const ping = state.hook.requests.at(-1);
      eq(ping.headers['x-ia-event'], 'ping', 'X-IA-Event');
      check(verifySignature(state.secret, ping.headers['x-ia-signature'], ping.headers['x-ia-timestamp'], ping.raw), 'ping signature does not verify');
      const avail = await api.expect('GET', '/api/v1/integrations/available');
      eq(avail.items.map((i) => i.type).sort().join(','), 'jira,webhook', 'available types');
      return 'ping verified by the receiver';
    });

    await run.step('a real P1 session over /signal: knock, accept, consent, end', async () => {
      const tok = await api.expect('POST', '/api/v1/tokens', { tier: 'p1_browser', typ: 'one_time', ttlMinutes: 15, label: 'smoke tickets' }, [201]);
      const assist = new SignalClient('assist', cfg.signalUrl, { Origin: cfg.webOrigin, Cookie: api.cookie });
      ctx.sockets.push(assist);
      await assist.open(T);
      assist.send({ t: 'assist.hello' });
      await assist.reply('assist.hello.ok', T);
      const desk = new SignalClient('desk', cfg.signalUrl, { Origin: cfg.webOrigin });
      ctx.sockets.push(desk);
      await desk.open(T);
      desk.send({ t: 'desk.hello', token: tok.compact, deskLabel: 'Smoke Desk' });
      await desk.reply('desk.hello.ok', T);
      desk.send({ t: 'desk.knock', deskLabel: 'Smoke Desk' });
      const knock = await desk.reply('knock.ok', T);
      state.sessionId = knock.sessionId;
      assist.send({ t: 'assist.accept', sessionId: state.sessionId });
      await assist.reply('session.created', T);
      await desk.reply('session.created', T);
      desk.send({ t: 'desk.consent', state: 'granted', surface: 'monitor' });
      await desk.reply('consent.ok', T);
      assist.send({ t: 'session.end', sessionId: state.sessionId, note: 'smoke tickets' });
      await assist.next((m) => m.t === 'session.ended', T, 'session.ended');
      assist.close();
      desk.close();
      return `session ${state.sessionId} ended`;
    });

    const pushTo = (type, body) => api.request('POST', `/api/v1/integrations/${type}/ticket`, { sessionId: state.sessionId, clientPushId: randomUUID(), ...body });

    await run.step('push a manual note to Jira -> delivered, idempotent on clientPushId', async () => {
      const body = { sessionId: state.sessionId, clientPushId: randomUUID(), mode: 'create', source: 'manual', note: 'Smoke: printer queue cleared.' };
      const r = await api.expect('POST', '/api/v1/integrations/jira/ticket', body, [201]);
      eq(r.push.state, 'delivered', 'push.state');
      check(/^OPS-\d+$/.test(r.push.externalId), `externalId ${r.push.externalId}`);
      check(!JSON.stringify(r).includes('printer queue cleared'), 'the ticket body was returned');
      const sent = state.jira.requests.at(-1);
      eq(sent.json?.fields?.description?.type, 'doc', 'Jira cloud body is ADF');
      const again = await api.expect('POST', '/api/v1/integrations/jira/ticket', body, [200]);
      eq(again.push.id, r.push.id, 'repeated clientPushId returns the same push');
      return `${r.push.externalId} (${r.push.externalUrl})`;
    });

    await run.step('push the AI summary (or the honest summary_not_ready when none is ready)', async () => {
      const s = await api.request('GET', `/api/v1/sessions/${state.sessionId}/summary`);
      const ready = s.status === 200 ? (s.json?.versions ?? []).filter((v) => v.state === 'ready') : [];
      const r = await pushTo('jira', { mode: 'create', source: 'summary' });
      if (ready.length === 0) {
        eq(r.status, 409, 'summary push status without a ready summary');
        eq(r.json?.error?.code, 'summary_not_ready', 'error code');
        return 'no ready summary on this api (the ai provider is not configured here): 409 summary_not_ready';
      }
      eq(r.status, 201, 'summary push status');
      eq(r.json.push.state, 'delivered', 'push.state');
      eq(r.json.push.summary.version, ready.at(-1).version, 'summary version');
      return `summary v${r.json.push.summary.version} delivered as ${r.json.push.externalId}`;
    });

    await run.step('push to the webhook -> delivered; the receiver verifies the signature and push id', async () => {
      const r = await pushTo('webhook', { mode: 'create', source: 'manual', note: 'Smoke webhook note.' });
      eq(r.status, 201, 'status');
      eq(r.json.push.state, 'delivered', 'push.state');
      const req = state.hook.requests.at(-1);
      eq(req.headers['x-ia-event'], 'ticket.push', 'X-IA-Event');
      eq(req.headers['x-ia-push-id'], r.json.push.id, 'X-IA-Push-Id');
      eq(req.headers['x-ia-attempt'], '1', 'X-IA-Attempt');
      check(verifySignature(state.secret, req.headers['x-ia-signature'], req.headers['x-ia-timestamp'], req.raw), 'signature does not verify');
      eq(req.json.pushId, r.json.push.id, 'body pushId');
      check(/^HOOK-\d+$/.test(r.json.push.externalId ?? ''), 'the receiver externalId was not recorded');
      return `signed delivery ${r.json.push.externalId}`;
    });

    await run.step('a 429 is retried by the sweeper (Retry-After honoured)', async () => {
      state.jira.script({ status: 429, json: { errorMessages: ['slow down'] }, headers: { 'retry-after': '1' } });
      const r = await pushTo('jira', { mode: 'create', source: 'manual', note: 'Smoke rate-limited note.' });
      eq(r.status, 201, 'status');
      eq(r.json.push.state, 'retrying', 'push.state after the 429');
      eq(r.json.push.lastFailure.cause, 'rate_limited', 'lastFailure.cause');
      const wait = Date.parse(r.json.push.nextAttemptAt) - Date.now();
      check(wait > 20_000 && wait <= 31_000, `next attempt in ${wait} ms, expected about 30 s`);
      const deadline = Date.now() + 75_000;
      let p = r.json.push;
      while (Date.now() < deadline && p.state === 'retrying') {
        await sleep(2000);
        const list = await api.expect('GET', `/api/v1/sessions/${state.sessionId}/tickets`);
        p = list.items.find((x) => x.id === r.json.push.id);
      }
      eq(p.state, 'delivered', 'push.state after the sweeper retry');
      eq(p.attempts, 2, 'attempts');
      return `delivered on attempt 2 as ${p.externalId}`;
    });

    await run.step('an ambiguous 500 is failed and never retried automatically', async () => {
      state.jira.script({ status: 500, json: { errorMessages: ['boom'] } });
      const before = state.jira.requests.length;
      const r = await pushTo('jira', { mode: 'create', source: 'manual', note: 'Smoke ambiguous note.' });
      eq(r.status, 201, 'status');
      eq(r.json.push.state, 'failed', 'push.state');
      eq(r.json.push.lastFailure.cause, 'upstream_error', 'cause');
      eq(r.json.push.nextAttemptAt, null, 'nextAttemptAt');
      await sleep(12_000); // longer than one sweeper interval
      eq(state.jira.requests.length, before + 1, 'requests to Jira (no automatic retry)');
      const list = await api.expect('GET', `/api/v1/sessions/${state.sessionId}/tickets`);
      eq(list.items.find((x) => x.id === r.json.push.id).state, 'failed', 'still failed');
      return 'failed, not retried';
    });

    await run.step('the session chain carries every push outcome (no body, no secret)', async () => {
      const audit = await api.expect('GET', `/api/v1/audit?sessionId=${state.sessionId}&limit=100`);
      const actions = audit.items.map((e) => e.action);
      for (const a of ['ticket.push_requested', 'ticket.push_delivered', 'ticket.push_failed']) check(actions.includes(a), `missing ${a}`);
      const text = JSON.stringify(audit);
      check(!text.includes('Smoke: printer queue cleared.') && !text.includes(state.secret), 'a body or secret is in the chain');
      return `${actions.filter((a) => a.startsWith('ticket.')).length} ticket entries`;
    });

    await run.step('DELETE both integrations', async () => {
      await api.expect('DELETE', '/api/v1/integrations/jira', undefined, [204]);
      await api.expect('DELETE', '/api/v1/integrations/webhook', undefined, [204]);
      const left = await api.expect('GET', '/api/v1/integrations');
      eq(left.items.length, 0, 'configured integrations left');
    });
  } finally {
    for (const f of fakes) await f.close();
  }
}
