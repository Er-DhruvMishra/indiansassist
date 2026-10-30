// Phase C smoke flow (docs/specs/phase-c-contracts.md section 15.4 `smoke:p3`), server side only, no browser and
// no media: a Node ws client simulates the native agent (Origin-less socket, `client.kind: 'native'`) through the
// tier gate, `desk.consent.native`, a `desk.event control.input { mode: 'os' }` whose chain entry carries
// `monitorId`, the hand-over on a one_time token (`desk.elevation` -> `elevation.handover` -> a second socket
// `desk.hello { handover }` -> `desk.hello.ok { resumeKey }`, the first socket `session.handed_over` + close 4411,
// `elevation.granted` in the audit), a playbook run whose 202 carries the body, and a download prepare + two grant
// GETs (the second a `206` Range request).

import { randomBytes } from 'node:crypto';
import { SignalClient } from './ws-client.mjs';
import { check, eq } from './runner.mjs';

export const NATIVE_CLIENT = {
  kind: 'native',
  version: '0.3.0',
  os: 'windows',
  platform: { osVersion: '10.0.26100', arch: 'x64' },
  tokenSource: 'manual',
  capabilities: {
    monitors: 2,
    elevation: 'user',
    features: ['screen', 'multi_monitor', 'input', 'input_text', 'clipboard', 'files', 'chat', 'voice', 'elevation', 'playbooks'],
    encoders: ['vp8', 'vp9'],
    hwEncoder: false,
    interpreters: ['powershell', 'cmd'],
  },
};
const UA = 'IndiansAssist-Agent/0.3.0 (Windows 10.0.26100; x64)';
const HEX64 = /^[0-9a-f]{64}$/;

/** @param {import('./runner.mjs').Runner} run */
export async function p3Steps(run, ctx) {
  const { api, state, cfg } = ctx;
  const T = cfg.timeoutMs;
  const desk = (name) => {
    // Origin-less upgrade with the agent UA (section 3.1): a deskOnly socket with a null principal.
    const c = new SignalClient(name, state.deskSignalUrl, { 'User-Agent': UA });
    ctx.sockets.push(c);
    return c;
  };

  await run.step('P3: well-known, signup on a p3_portable plan, seat raised to p3_portable', async () => {
    const wk = await api.expect('GET', '/.well-known/indiansassist.json');
    if (!cfg.webOrigin) cfg.webOrigin = new URL(wk.join).origin;
    if (!cfg.signalUrl) cfg.signalUrl = wk.signal;
    api.origin = cfg.webOrigin;
    const h = await api.expect('GET', '/api/v1/health');
    state.region = h.servedRegions.length > 0 ? h.servedRegions[0] : h.region;
    const s = randomBytes(4).toString('hex');
    const body = { orgName: `Smoke P3 ${s}`, region: state.region, name: `Smoke P3 ${s}`, email: `smoke-p3-${s}@example.com`, password: `Smoke-${randomBytes(12).toString('base64url')}` };
    const r = await api.expect('POST', '/api/v1/auth/signup', body, [201]);
    check(['p3_portable', 'p4_installed'].includes(r.org.planTier), `org.planTier ${r.org.planTier} (start the api with SIGNUP_PLAN_TIER=p3_portable)`);
    state.user = r.user;
    await api.expect('PATCH', `/api/v1/users/${r.user.id}/role`, { role: 'org_admin', tier: 'p3_portable' });
    return `org ${r.org.slug}, region ${state.region}`;
  });

  await run.step('P3: one_time p3_portable token; public-lookup without Origin says joinSupported + agent', async () => {
    const r = await api.expect('POST', '/api/v1/tokens', { tier: 'p3_portable', typ: 'one_time', label: 'smoke-p3' }, [201]);
    state.token = r.token;
    state.compact = r.compact;
    const res = await (ctx.fetchImpl ?? fetch)(`${cfg.apiUrl}/api/v1/tokens/public-lookup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'IndiansAssist', 'User-Agent': UA },
      body: JSON.stringify({ code: state.compact }),
    });
    eq(res.status, 200, 'public-lookup status');
    const pub = await res.json();
    eq(pub.tier, 'p3_portable', 'tier');
    eq(pub.joinSupported, true, 'joinSupported (section 13.3)');
    check(pub.agent && typeof pub.agent.minVersion === 'string', 'PublicToken.agent (section 2.7 J6)');
    state.deskSignalUrl = cfg.signalUrlOverride ?? pub.signalUrl;
    return `token ${r.token.id}`;
  });

  await run.step('P3 WS: assist.hello; web client refused; Origin-less native Desk passes the tier gate', async () => {
    const assist = new SignalClient('assist', cfg.signalUrl, { Origin: cfg.webOrigin, Cookie: api.cookie });
    ctx.sockets.push(assist);
    await assist.open(T);
    assist.send({ t: 'assist.hello' });
    await assist.reply('assist.hello.ok', T);
    state.assist = assist;
    const web = new SignalClient('web-desk', state.deskSignalUrl, { Origin: cfg.webOrigin });
    ctx.sockets.push(web);
    await web.open(T);
    web.send({ t: 'desk.hello', token: state.compact });
    const err = await web.next('error', T);
    eq(err.code, 'join_unsupported', 'a web client on a p3 token');
    eq(err.details?.expectedClient, 'native', 'details.expectedClient');
    const d = desk('desk');
    await d.open(T);
    d.send({ t: 'assist.hello' });
    eq((await d.next('error', T)).code, 'forbidden', 'assist.hello on an Origin-less socket');
    const d1 = desk('desk');
    await d1.open(T);
    d1.send({ t: 'desk.hello', token: state.compact, deskLabel: 'Smoke P3 Desk', client: NATIVE_CLIENT });
    const ok = await d1.reply('desk.hello.ok', T);
    eq(ok.tier, 'p3_portable', 'desk.hello.ok tier');
    state.desk = d1;
    return `native Desk ${ok.connectionId}`;
  });

  await run.step('P3 WS: knock, accept (session.created.agent.playbooks), desk.consent.native -> consent.changed', async () => {
    const { assist, desk: d } = state;
    d.send({ t: 'desk.knock', deskLabel: 'Smoke P3 Desk' });
    const knock = await d.reply('knock.ok', T);
    state.sessionId = knock.sessionId;
    await assist.next((m) => m.t === 'assist.knock' && m.sessionId === knock.sessionId, T, 'assist.knock');
    assist.send({ t: 'assist.accept', sessionId: knock.sessionId });
    const created = await assist.reply('session.created', T);
    eq(created.tier, 'p3_portable', 'session.created tier');
    check(Array.isArray(created.agent?.playbooks), 'session.created.agent.playbooks (section 8.3)');
    await d.reply('session.created', T);
    d.send({ t: 'desk.consent', state: 'granted', surface: 'monitor', native: { level: 'control', monitors: [1, 2], clipboard: false } });
    eq((await d.reply('consent.ok', T)).state, 'active', 'consent.ok state');
    const changed = await assist.reply('consent.changed', T);
    eq(changed.level, 'control', 'consent.changed level');
    eq(changed.monitors, 2, 'consent.changed monitors');
    eq(changed.clipboard, false, 'consent.changed clipboard');
    return `session ${knock.sessionId} active at control`;
  });

  await run.step('P3 WS: relay fallback refused for p3 (mirror.relay / control.relay -> bad_state)', async () => {
    const { assist, sessionId } = state;
    assist.send({ t: 'control.relay', sessionId, msg: { t: 'ctl.req', id: 'x1', op: 'os.monitors', args: {}, ts: Date.now() } });
    eq((await assist.next('error', T)).code, 'bad_state', 'control.relay on p3');
  });

  await run.step('P3: desk.event control.input { mode: os } and the user twin (chain entries carry monitorId)', async () => {
    const { desk: d, sessionId } = state;
    const data = { mode: 'os', monitorId: 2, count: 3, kinds: ['pointer', 'text'], windowMs: 10000, textChars: 5 };
    d.send({ t: 'desk.event', sessionId, action: 'control.input', data: { ...data, refused: 1 } });
    await d.reply('event.ok', T);
    await api.expect('POST', `/api/v1/sessions/${sessionId}/events`, { action: 'control.input', data }, [201]);
  });

  await run.step('P3: hand-over on the one_time token (desk.elevation -> handover hello -> 4411)', async () => {
    const { assist, desk: d1, sessionId } = state;
    const opId = 'abcdef0123456789';
    d1.send({ t: 'desk.elevation', sessionId, opId });
    const ho = await d1.reply('elevation.handover', T);
    check(typeof ho.handover === 'string' && ho.handover.length >= 43, 'elevation.handover.handover');
    const d2 = desk('desk-admin');
    await d2.open(T);
    d2.send({ t: 'desk.hello', token: state.compact, handover: ho.handover, client: { ...NATIVE_CLIENT, capabilities: { ...NATIVE_CLIENT.capabilities, elevation: 'admin' } } });
    const ok = await d2.reply('desk.hello.ok', T);
    check(typeof ok.resumeKey === 'string', 'desk.hello.ok.resumeKey on a hand-over');
    eq(ok.resume?.state, 'active', 'resume.state');
    await d1.next('session.handed_over', T);
    eq((await d1.waitClose(T)).code, 4411, 'old Desk close code');
    await assist.next('desk.reconnected', T);
    const again = desk('desk-replay');
    await again.open(T);
    again.send({ t: 'desk.hello', token: state.compact, handover: ho.handover, client: NATIVE_CLIENT });
    eq((await again.next('error', T)).code, 'forbidden', 'a consumed hand-over is refused');
    state.desk = d2;
    state.opId = opId;
  });

  await run.step('P3: playbook create + run (202 carries body, runId, opId)', async () => {
    const pb = await api.expect('POST', '/api/v1/orgs/current/playbooks', { name: 'Smoke flush DNS', description: 'smoke', interpreter: 'cmd', body: 'ipconfig /flushdns', timeoutSec: 30 }, [201]);
    check(HEX64.test(pb.bodyHash), 'server-computed bodyHash');
    const r = await api.expect('POST', `/api/v1/sessions/${state.sessionId}/playbooks/${pb.id}/run`, { args: {} }, [202]);
    eq(r.body, 'ipconfig /flushdns', '202 body');
    check(/^[0-9a-f]{32}$/.test(r.runId) && /^[0-9a-f]{16}$/.test(r.opId), 'runId / opId');
    state.run = r;
  });

  await run.step('P3: session end and audit (elevation.granted, playbook.run_requested, control.input monitorId)', async () => {
    const { assist, sessionId } = state;
    assist.send({ t: 'session.end', sessionId });
    await assist.reply('session.ended', T);
    const a = await api.expect('GET', `/api/v1/sessions/${sessionId}/audit?limit=200`);
    const actions = (a.items ?? []).map((e) => e.action);
    for (const want of ['elevation.handover_minted', 'elevation.granted', 'playbook.run_requested', 'control.input']) {
      check(actions.includes(want), `audit lacks ${want}`);
    }
    const ci = a.items.find((e) => e.action === 'control.input' && e.actor?.type === 'desk');
    eq(ci?.data?.monitorId, 2, 'control.input chain monitorId');
    return `${actions.length} entries`;
  });

  await run.step('P3: download manifest, prepare, two grant GETs (second 206 with Range)', async () => {
    const m = await api.expect('GET', '/api/v1/download/manifest');
    const win = (m.builds ?? []).find((b) => b.platform === 'windows' && b.arch === 'x64');
    check(win, 'manifest has a windows x64 build (AGENT_DIST_DIR)');
    const t = await api.expect('POST', '/api/v1/tokens', { tier: 'p3_portable', typ: 'timed', ttlMinutes: 30, label: 'smoke-p3-dl' }, [201]);
    const p = await api.expect('POST', '/api/v1/download/prepare', { code: t.compact, platform: 'windows', arch: 'x64' }, [201]);
    check(/^IndiansAssist-[a-z]{2}-[a-z]{3,5}-\d{4}-\d{4}-\d{4}\.exe$/.test(p.filename), `filename ${p.filename}`);
    const get1 = await (ctx.fetchImpl ?? fetch)(p.url);
    eq(get1.status, 200, 'first GET');
    const get2 = await (ctx.fetchImpl ?? fetch)(p.url, { headers: { Range: 'bytes=0-15' } });
    eq(get2.status, 206, 'Range GET');
    return p.filename;
  });
}
