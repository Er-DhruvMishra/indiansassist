// Phase B smoke flow (docs/specs/phase-b-contracts.md section 13.3), server side only, no browser: P2 licence,
// extension policy and retention policy, a p2_extension token, public lookup from an extension Origin, an
// extension Desk through the tier gate, knock / accept / consent with a consent level, a mirror.relay batch
// forwarded to the Assist, a control.relay request above the granted level refused, a level change, the dual
// tab.action attestation and the session end. The audit checks are in flow-p2-audit.mjs.

import { randomBytes } from 'node:crypto';
import { ApiClient } from './http.mjs';
import { SignalClient } from './ws-client.mjs';
import { assertServerFrame } from './shared.mjs';
import { check, eq } from './runner.mjs';

export const EXTENSION_CLIENT = { kind: 'extension', version: '0.2.0', browser: { name: 'chrome', version: '131' }, os: 'linux' };
const OP = 'abcdef0123456789';
const MODS = { alt: false, ctrl: false, meta: false, shift: false };
/** base64url of a tiny deflated `[]`: opaque to the server, which never inflates relay data. */
const BATCH = 'eJyLjgUAARUAuQ';

/** @param {import('./runner.mjs').Runner} run */
export async function p2SetupSteps(run, ctx) {
  const { api, state, cfg } = ctx;

  await run.step('P2: GET /.well-known/indiansassist.json', async () => {
    const wk = await api.expect('GET', '/.well-known/indiansassist.json');
    if (!cfg.webOrigin) cfg.webOrigin = new URL(wk.join).origin;
    if (!cfg.signalUrl) cfg.signalUrl = wk.signal;
    api.origin = cfg.webOrigin;
    const h = await api.expect('GET', '/api/v1/health');
    state.region = h.servedRegions.length > 0 ? h.servedRegions[0] : h.region;
    return `signal ${cfg.signalUrl}, region ${state.region}`;
  });

  await run.step('P2: signup + raise own seat to p2_extension', async () => {
    const s = randomBytes(4).toString('hex');
    const body = { orgName: `Smoke P2 ${s}`, region: state.region, name: `Smoke P2 ${s}`, email: `smoke-p2-${s}@example.com`, password: `Smoke-${randomBytes(12).toString('base64url')}` };
    const r = await api.expect('POST', '/api/v1/auth/signup', body, [201]);
    eq(r.org.planTier, 'p2_extension', 'org.planTier (SIGNUP_PLAN_TIER)');
    state.user = r.user;
    state.org = r.org;
    const role = await api.expect('PATCH', `/api/v1/users/${r.user.id}/role`, { role: 'org_admin', tier: 'p2_extension' });
    eq(role.seat?.tier ?? 'p2_extension', 'p2_extension', 'seat.tier');
    return `org ${r.org.slug}`;
  });

  await run.step('P2: extension policy GET / PATCH and retention GET / PATCH', async () => {
    const p = await api.expect('GET', '/api/v1/orgs/current/policy/extension');
    eq(p.allowRelayFallback, true, 'default allowRelayFallback');
    check(Array.isArray(p.builtinDenyList) && p.builtinDenyList.includes('accounts.google.com'), 'builtinDenyList');
    const patched = await api.expect('PATCH', '/api/v1/orgs/current/policy/extension', { denyList: ['Bank.Example.test'], titlePrefix: false });
    eq(patched.denyList[0], 'bank.example.test', 'normalised deny-list entry');
    eq(patched.titlePrefix, false, 'titlePrefix');
    const bad = await api.request('PATCH', '/api/v1/orgs/current/policy/extension', { maxConsentLevel: 'view' });
    eq(bad.status, 400, 'default level above the cap is refused');
    eq((await api.expect('GET', '/api/v1/orgs/current/policy/retention')).recordingRetentionDays, null, 'retention default');
    eq((await api.expect('PATCH', '/api/v1/orgs/current/policy/retention', { recordingRetentionDays: 90 })).recordingRetentionDays, 90, 'retention');
  });

  await run.step('P2: POST /api/v1/tokens (p2_extension, timed)', async () => {
    const r = await api.expect('POST', '/api/v1/tokens', { tier: 'p2_extension', typ: 'timed', ttlMinutes: 30, label: 'smoke-p2' }, [201]);
    eq(r.token.tier, 'p2_extension', 'token.tier');
    state.token = r.token;
    state.compact = r.compact;
    return `token ${r.token.id}`;
  });

  await run.step('P2: public-lookup from an extension Origin (X-Requested-With)', async () => {
    const ext = new ApiClient(cfg.apiUrl, { origin: cfg.extensionOrigin, fetchImpl: ctx.fetchImpl });
    const r = await ext.expect('POST', '/api/v1/tokens/public-lookup', { code: state.compact });
    eq(r.tier, 'p2_extension', 'tier');
    eq(r.joinSupported, true, 'joinSupported');
    check(r.extension && Array.isArray(r.extension.ids) && typeof r.extension.minVersion === 'string', 'extension install info');
    state.deskSignalUrl = cfg.signalUrlOverride ?? r.signalUrl;
    return `minVersion ${r.extension.minVersion}, ${r.extension.ids.length} listed id(s)`;
  });
}

/** @param {import('./runner.mjs').Runner} run */
export async function p2SignalSteps(run, ctx) {
  const { shared, state, cfg } = ctx;
  const T = cfg.timeoutMs;
  const frame = (m, label) => assertServerFrame(shared, m, label);
  const reply = async (client, t) => frame(await client.reply(t, T), `${client.name} ${t}`);

  await run.step('P2 WS: assist.hello and an extension Desk through the tier gate', async () => {
    const assist = new SignalClient('assist', cfg.signalUrl, { Origin: cfg.webOrigin, Cookie: ctx.api.cookie });
    ctx.sockets.push(assist);
    await assist.open(T);
    assist.send({ t: 'assist.hello' });
    await reply(assist, 'assist.hello.ok');
    state.assist = assist;
    const web = new SignalClient('web-desk', state.deskSignalUrl, { Origin: cfg.webOrigin });
    ctx.sockets.push(web);
    await web.open(T);
    web.send({ t: 'desk.hello', token: state.compact });
    const err = await web.next('error', T);
    eq(err.code, 'join_unsupported', 'a web client on a p2 token');
    eq(err.details?.expectedClient, 'extension', 'details.expectedClient');
    const desk = new SignalClient('desk', state.deskSignalUrl, { Origin: cfg.extensionOrigin });
    ctx.sockets.push(desk);
    await desk.open(T);
    desk.send({ t: 'desk.hello', token: state.compact, deskLabel: 'Smoke P2 Desk', client: EXTENSION_CLIENT });
    const ok = await reply(desk, 'desk.hello.ok');
    eq(ok.tier, 'p2_extension', 'desk.hello.ok tier');
    state.desk = desk;
    return `extension Desk ${ok.connectionId}`;
  });

  await run.step('P2 WS: knock, accept (session.created carries the policy), consent tab_control', async () => {
    const { assist, desk } = state;
    desk.send({ t: 'desk.knock' });
    const knock = await reply(desk, 'knock.ok');
    state.sessionId = knock.sessionId;
    await assist.next((m) => m.t === 'assist.knock' && m.sessionId === knock.sessionId, T, 'assist.knock');
    assist.send({ t: 'assist.accept', sessionId: knock.sessionId });
    const created = await reply(assist, 'session.created');
    eq(created.tier, 'p2_extension', 'session.created tier');
    eq(created.extension?.policy?.titlePrefix, false, 'session.created extension.policy (patched)');
    const deskCreated = await reply(desk, 'session.created');
    check(deskCreated.extension?.policy, 'Desk copy of session.created carries the policy');
    check(deskCreated.iceServers === undefined, 'Desk copy of session.created carries no ICE');
    const extension = { level: 'tab_control', scope: 'current_tab', backstage: false };
    desk.send({ t: 'desk.consent', state: 'granted', surface: 'browser', extension });
    const ok = await reply(desk, 'consent.ok');
    eq(ok.state, 'active', 'consent.ok state');
    const changed = await reply(assist, 'consent.changed');
    eq(changed.level, 'tab_control', 'consent.changed level');
    eq(changed.scope, 'current_tab', 'consent.changed scope');
    return `session ${knock.sessionId} active at tab_control`;
  });

  await run.step('P2 WS: mirror.relay batch forwarded to the Assist unchanged', async () => {
    const { assist, desk, sessionId } = state;
    const batch = { t: 'mirror.relay', sessionId, tabId: 12, seq: 1, kind: 'batch', enc: 'deflate', part: 1, parts: 1, data: BATCH };
    desk.send(batch);
    const got = frame(await assist.next('mirror.relay', T), 'mirror.relay');
    eq(got.data, BATCH, 'relayed data');
    eq(got.tabId, 12, 'relayed tabId');
    assist.send({ t: 'mirror.relay', sessionId, tabId: 12, seq: 1, kind: 'batch', enc: 'none', part: 1, parts: 1, data: 'AA' });
    eq((await assist.next('error', T)).code, 'bad_payload', 'Assist may relay kind json only');
  });

  await run.step('P2 WS: control.relay above the granted level is refused (consent_required)', async () => {
    const { assist, desk, sessionId } = state;
    const click = { t: 'ctl.req', id: 'smoke-click-1', op: 'input.pointer', args: { tabId: 12, kind: 'click', nodeId: null, vx: 0.5, vy: 0.5, modifiers: MODS }, ts: Date.now() };
    assist.send({ t: 'control.relay', sessionId, msg: click });
    const err = await assist.next('error', T);
    eq(err.code, 'consent_required', 'error code');
    eq(err.details?.required, 'in_page', 'details.required');
    eq(err.details?.granted, 'tab_control', 'details.granted');
    state.refusedOpId = err.details?.opId;
    const list = { t: 'ctl.req', id: 'smoke-list-1', op: 'tabs.list', args: {}, ts: Date.now() };
    assist.send({ t: 'control.relay', sessionId, msg: list });
    const fwd = await desk.next('control.relay', T);
    eq(fwd.msg?.op, 'tabs.list', 'the view-level request reached the Desk (the refused one did not)');
    desk.send({ t: 'control.relay', sessionId, msg: { t: 'ctl.res', id: 'smoke-list-1', ok: true, result: { tabs: [], hiddenCount: 0 }, ts: Date.now() } });
    eq((await assist.next('control.relay', T)).msg?.t, 'ctl.res', 'ctl.res relayed back');
    return `opId ${state.refusedOpId}`;
  });

  await run.step('P2 WS: desk.consent_level (requested) and dual tab.action attestation', async () => {
    const { assist, desk, sessionId } = state;
    desk.send({ t: 'desk.consent_level', sessionId, level: 'in_page', requested: true, opId: OP });
    eq((await reply(desk, 'consent.level_ok')).level, 'in_page', 'consent.level_ok level');
    eq((await reply(assist, 'consent.changed')).level, 'in_page', 'consent.changed level');
    desk.send({ t: 'desk.event', sessionId, action: 'tab.action', data: { kind: 'tabs.navigate', opId: OP, tabId: 12, host: 'example.com', ok: true } });
    await reply(desk, 'event.ok');
    await ctx.api.expect('POST', `/api/v1/sessions/${sessionId}/events`, { action: 'tab.action', data: { kind: 'tabs.navigate', opId: OP, tabId: 12, host: 'example.com' } }, [201]);
  });

  await run.step('P2 WS: assist session.end -> session.ended on both sides, Desk closed 4410', async () => {
    const { assist, desk, sessionId } = state;
    assist.send({ t: 'session.end', sessionId });
    const a = await reply(assist, 'session.ended');
    eq(a.endReason, 'assist_ended', 'endReason');
    state.hashChainTail = a.hashChainTail;
    await reply(desk, 'session.ended');
    eq((await desk.waitClose(T)).code, 4410, 'Desk close code');
  });
}
