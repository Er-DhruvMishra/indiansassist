// Phase C smoke flow, part 1 (docs/specs/phase-c-contracts.md section 15.4 `smoke:p3`), server side only, no
// browser and no media: a Node ws client plays the native agent (Origin-less socket, `client.kind: 'native'`)
// through the tier gate, poll, knock, accept (`session.created.agent.playbooks`), `desk.consent.native` with two
// monitors, and the refused relay fallback. Part 2 (flow-p3-agent.mjs) runs the ia.sec handshake in-process, the
// level gate, the hand-over, a playbook run, the end, the chain verification and the download grant.

import { randomBytes } from 'node:crypto';
import { SignalClient } from './ws-client.mjs';
import { assertServerFrame, loadShared } from './shared.mjs';
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
export const ADMIN_CLIENT = { ...NATIVE_CLIENT, capabilities: { ...NATIVE_CLIENT.capabilities, elevation: 'admin' } };
export const AGENT_UA = 'IndiansAssist-Agent/0.3.0 (Windows 10.0.26100; x64)';

/** An Origin-less socket with the agent UA (section 3.1): a deskOnly socket with a null principal. */
export function nativeSocket(ctx, name) {
  const c = new SignalClient(name, ctx.state.deskSignalUrl, { 'User-Agent': AGENT_UA });
  ctx.sockets.push(c);
  return c;
}

/** @param {import('./runner.mjs').Runner} run */
export async function p3Steps(run, ctx) {
  const { api, state, cfg } = ctx;
  const T = cfg.timeoutMs;

  await run.step('P3: load @indiansassist/shared (built, with the Phase C exports)', async () => {
    ctx.shared = await loadShared();
    if (typeof ctx.shared.SecHandshake !== 'function') throw new Error('packages/shared/dist predates Phase C; rebuild it');
  });

  await run.step('P3: well-known, signup on a p3_portable plan, seat raised to p3_portable, agent policy', async () => {
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
    state.org = r.org;
    await api.expect('PATCH', `/api/v1/users/${r.user.id}/role`, { role: 'org_admin', tier: 'p3_portable' });
    eq((await api.expect('GET', '/api/v1/orgs/current/policy/agent')).requireSasConfirm, true, 'requireSasConfirm default');
    return `org ${r.org.slug}, region ${state.region}`;
  });

  await run.step('P3: one_time p3_portable token; public-lookup without Origin says joinSupported + agent', async () => {
    const r = await api.expect('POST', '/api/v1/tokens', { tier: 'p3_portable', typ: 'one_time', label: 'smoke-p3' }, [201]);
    state.token = r.token;
    state.compact = r.compact;
    const res = await (ctx.fetchImpl ?? fetch)(`${cfg.apiUrl}/api/v1/tokens/public-lookup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'IndiansAssist', 'User-Agent': AGENT_UA },
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

  await run.step('P3 WS: assist.hello; web client refused; Origin-less assist refused; native desk.hello ok', async () => {
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
    const bare = nativeSocket(ctx, 'bare');
    await bare.open(T);
    bare.send({ t: 'assist.hello' });
    eq((await bare.next('error', T)).code, 'forbidden', 'assist.hello on an Origin-less socket');
    eq((await bare.waitClose(T)).code, 4403, 'Origin-less assist close code');
    const d1 = nativeSocket(ctx, 'desk');
    await d1.open(T);
    d1.send({ t: 'desk.hello', token: state.compact, deskLabel: 'Smoke P3 Desk', client: NATIVE_CLIENT });
    const ok = assertServerFrame(ctx.shared, await d1.reply('desk.hello.ok', T));
    eq(ok.tier, 'p3_portable', 'desk.hello.ok tier');
    state.desk = d1;
    return `native Desk ${ok.connectionId}`;
  });

  await run.step('P3 WS: poll, knock, accept (agent.playbooks pinned on both copies), desk.consent.native', async () => {
    const { assist, desk: d } = state;
    d.send({ t: 'desk.poll' });
    eq((await d.reply('poll.status', T)).state, 'waiting', 'poll.status before the knock');
    d.send({ t: 'desk.knock', deskLabel: 'Smoke P3 Desk' });
    const knock = await d.reply('knock.ok', T);
    state.sessionId = knock.sessionId;
    state.resumeKey = knock.resumeKey;
    await assist.next((m) => m.t === 'assist.knock' && m.sessionId === knock.sessionId, T, 'assist.knock');
    assist.send({ t: 'assist.accept', sessionId: knock.sessionId });
    const created = assertServerFrame(ctx.shared, await assist.reply('session.created', T));
    eq(created.tier, 'p3_portable', 'session.created tier');
    const flush = created.agent?.playbooks?.find((p) => p.name === 'Flush DNS cache');
    check(flush, 'the starter catalogue is in session.created.agent.playbooks (section 8.3 / 8.6)');
    check(!('body' in flush), 'the manifest carries no body');
    state.manifest = created.agent.playbooks;
    const deskCreated = assertServerFrame(ctx.shared, await d.reply('session.created', T));
    eq(JSON.stringify(deskCreated.agent), JSON.stringify(created.agent), 'both copies carry the same manifest');
    d.send({ t: 'desk.consent', state: 'granted', surface: 'monitor', native: { level: 'control', monitors: [1, 2], clipboard: false } });
    eq((await d.reply('consent.ok', T)).state, 'active', 'consent.ok state');
    const changed = await assist.reply('consent.changed', T);
    eq(changed.level, 'control', 'consent.changed level');
    eq(changed.monitors, 2, 'consent.changed monitors');
    eq(changed.clipboard, false, 'consent.changed clipboard');
    return `session ${knock.sessionId} active at control, ${state.manifest.length} playbooks pinned`;
  });

  await run.step('P3 WS: relay fallback refused for p3 (control.relay -> bad_state)', async () => {
    const { assist, sessionId } = state;
    assist.send({ t: 'control.relay', sessionId, msg: { t: 'ctl.req', id: 'x1', op: 'tabs.list', args: {}, ts: Date.now() } });
    eq((await assist.next('error', T)).code, 'bad_state', 'control.relay on p3');
  });
}
