// Phase D smoke flow (docs/specs/phase-d-contracts.md section 15.3 `smoke:p4`), server side only, no browser and no
// media: Node ws clients play two installed services (a target device and its LAN waker peer) and the target's
// desktop worker. Enrollment with a region-signed enroll.iaconfig, the signed /signal/device challenge, an unattended
// session reaching active with session.unattended_started chained (its policy snapshot and approvedBy readable back
// on REST and in session.created) and a valid device_attest, the rule 6.2a arrival push to the console, a queued action
// delivered on reconnect with its signed result chained, a vault-backed action whose secret is read at dispatch only
// (sealed to the one device, or an honest vault_unavailable on a node with no vault), a wake whose waker opens the
// sealed MAC and confirms, a device.tamper producing tamper.alert, the signed deregister, and the org chain verified.

import { randomBytes } from 'node:crypto';
import { SignalClient } from './ws-client.mjs';
import { assertServerFrame, loadShared } from './shared.mjs';
import { check, eq } from './runner.mjs';
import { verifySessionAudit } from './audit.mjs';

export const WORKER_UA = 'IndiansAssist-Agent/0.4.0 (Windows 10.0.26100; x64)';
const SERVICE_UA = 'IndiansAssist-Service/0.4.0 (Windows 10.0.26100; x64)';

const SERVICE_FEATURES_A = ['screen', 'multi_monitor', 'input', 'input_text', 'clipboard', 'files', 'chat', 'playbooks', 'input_lock', 'privacy_screen', 'secure_desktop', 'service_input', 'sas'];
const SERVICE_FEATURES_B = ['screen', 'input', 'waker', 'service_input'];

/** One simulated installed service (identity + sealing keys generated "on the device"). */
class SimDevice {
  constructor(shared, name, features) {
    this.s = shared;
    this.name = name;
    this.seed = new Uint8Array(randomBytes(32));
    this.kexSecret = new Uint8Array(randomBytes(32));
    this.publicKey = shared.devicePublicKeyOf(this.seed);
    this.kexPublicKey = shared.kexPublicKeyOf(this.kexSecret);
    this.keyId = shared.kidOf(shared.base64urlDecode(this.publicKey));
    this.wakeMac = randomBytes(6).toString('hex');
    this.features = features;
    this.hw = randomBytes(32).toString('hex');
    this.interactive = { state: 'locked', idleSec: null, at: Date.now() };
    this.deviceId = null;
    this.ws = null;
  }

  capabilities() {
    return { monitors: 1, elevation: 'admin', features: this.features, encoders: ['vp8'], hwEncoder: false, interpreters: ['powershell'], serviceVersion: '0.4.0' };
  }

  sign(input) {
    return this.s.signDeviceInput(input, this.seed);
  }

  enrollBody(enrollConfig, tokenId) {
    return {
      enrollConfig,
      devicePublicKey: this.publicKey,
      deviceKexPublicKey: this.kexPublicKey,
      deviceKeyProof: this.sign(this.s.deviceSigInput.enroll({ tokenId, devicePublicKey: this.publicKey, deviceKexPublicKey: this.kexPublicKey })),
      machine: {
        name: this.name,
        platform: 'windows',
        osVersion: '10.0.26100',
        arch: 'x64',
        serviceVersion: '0.4.0',
        hwFingerprint: this.hw,
        wakeMac: this.wakeMac,
        amt: null,
        capabilities: this.capabilities(),
        interactive: this.interactive,
      },
    };
  }

  lanSegment(orgId) {
    const subnet = this.s.sha256Hex(`ia-seg-v1/${orgId}/10.20.30.0/24/aa:bb:cc:dd:ee:ff`);
    return { subnetHash: subnet, gatewayMacHash: this.s.sha256Hex(`ia-gw-v1/${orgId}/aa:bb:cc:dd:ee:ff`) };
  }

  /** Opens /signal/device, answers the challenge; resolves with `device.hello.ok`. */
  async connect(ctx, opts = {}) {
    const ws = new SignalClient(`device-${this.name}`, ctx.state.deviceSignalUrl, { 'User-Agent': SERVICE_UA });
    ctx.sockets.push(ws);
    await ws.open(ctx.cfg.timeoutMs);
    const ch = assertDeviceFrame(this.s, await ws.next('device.challenge', ctx.cfg.timeoutMs));
    const nonce = this.s.base64urlEncode(new Uint8Array(randomBytes(16)));
    const sig = opts.badSig ? this.s.base64urlEncode(new Uint8Array(64)) : this.sign(this.s.deviceSigInput.hello({ deviceId: this.deviceId, serverChallenge: ch.serverChallenge, nonce }));
    ws.send({
      t: 'device.hello',
      deviceId: this.deviceId,
      keyId: this.keyId,
      nonce,
      sig,
      client: {
        serviceVersion: '0.4.0',
        agentVersion: '0.4.0',
        osVersion: '10.0.26100',
        arch: 'x64',
        capabilities: this.capabilities(),
        lanSegment: this.lanSegment(ctx.state.org.id),
        wakeMac: this.wakeMac,
        amt: null,
        interactive: this.interactive,
      },
    });
    this.ws = ws;
    if (opts.expectError) return ws;
    return assertDeviceFrame(this.s, await ws.reply('device.hello.ok', ctx.cfg.timeoutMs));
  }
}

function assertDeviceFrame(shared, frame) {
  const r = shared.parseDeviceServerMessage(frame);
  if (!r.ok) throw new Error(`${frame?.t}: frame does not match the /signal/device schema (${(r.issues ?? []).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')})`);
  return r.msg;
}

const workerClient = (features) => ({
  kind: 'native',
  version: '0.4.0',
  os: 'windows',
  platform: { osVersion: '10.0.26100', arch: 'x64' },
  tokenSource: 'service',
  capabilities: { monitors: 1, elevation: 'admin', features, encoders: ['vp8'], hwEncoder: false, interpreters: ['powershell'] },
});

/** @param {import('./runner.mjs').Runner} run */
export async function p4Steps(run, ctx) {
  const { api, state, cfg } = ctx;
  const T = cfg.timeoutMs;
  const rawPost = async (path, body, headers = {}) => {
    const res = await (ctx.fetchImpl ?? fetch)(`${cfg.apiUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'IndiansAssist', 'User-Agent': SERVICE_UA, ...headers },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };

  await run.step('P4: load @indiansassist/shared (built, with the Phase D exports)', async () => {
    ctx.shared = await loadShared();
    if (typeof ctx.shared.decideDeviceSession !== 'function' || typeof ctx.shared.parseDeviceServerMessage !== 'function')
      throw new Error('packages/shared/dist predates Phase D; rebuild it');
  });
  const s = () => ctx.shared;

  await run.step('P4: signup on a p4_installed plan, org_admin seat at p4_installed, safe default unattended policy', async () => {
    const wk = await api.expect('GET', '/.well-known/indiansassist.json');
    if (!cfg.webOrigin) cfg.webOrigin = new URL(wk.join).origin;
    if (!cfg.signalUrl) cfg.signalUrl = wk.signal;
    state.keys = wk.keys;
    api.origin = cfg.webOrigin;
    const h = await api.expect('GET', '/api/v1/health');
    state.region = h.servedRegions.length > 0 ? h.servedRegions[0] : h.region;
    const sx = randomBytes(4).toString('hex');
    const r = await api.expect('POST', '/api/v1/auth/signup', { orgName: `Smoke P4 ${sx}`, region: state.region, name: `Smoke P4 ${sx}`, email: `smoke-p4-${sx}@example.com`, password: `Smoke-${randomBytes(12).toString('base64url')}` }, [201]);
    check(r.org.planTier === 'p4_installed', `org.planTier ${r.org.planTier} (start the api with SIGNUP_PLAN_TIER=p4_installed)`);
    state.user = r.user;
    state.org = r.org;
    await api.expect('PATCH', `/api/v1/users/${r.user.id}/role`, { role: 'org_admin', tier: 'p4_installed' });
    const def = await api.expect('GET', '/api/v1/orgs/current/policy/unattended');
    eq(def.mode, 'approval_only', 'default unattended mode (W42)');
    eq(def.recordingRequired, true, 'default recordingRequired');
    return `org ${r.org.slug}, region ${state.region}`;
  });

  await run.step('P4: device group with an allow policy; enrollment token (maxDevices 2); signed enroll.iaconfig', async () => {
    const g = await api.expect('POST', '/api/v1/orgs/current/device-groups', { name: 'Smoke unattended', defaultPolicy: { mode: 'allow', recordingRequired: false, requireLocalApprovalWhenPresent: true, maxUnattendedMinutes: 60 }, notifyEmail: 'it@example.com' }, [201]);
    state.group = g;
    const t = await api.expect('POST', '/api/v1/tokens', { tier: 'p4_installed', typ: 'enrollment', maxDevices: 2, label: 'smoke-p4 rollout' }, [201]);
    eq(t.token.maxDevices, 2, 'token.maxDevices');
    eq(t.token.devicesEnrolled, 0, 'token.devicesEnrolled');
    state.enrollToken = t.token;
    const cfgReply = await api.expect('GET', `/api/v1/devices/enroll-config?tokenId=${t.token.id}&groupId=${g.id}`);
    const keys = state.keys.map((k) => ({ kid: k.kid, pub: k.pub }));
    const verified = await s().verifyEnrollConfig(cfgReply.iaconfig, keys);
    check(verified, 'enroll.iaconfig verifies against the region keys of the well-known document');
    eq(verified.groupId, g.id, 'iaconfig.groupId');
    check(verified.signalUrl.endsWith('/signal/device'), 'iaconfig.signalUrl is the /signal/device URL');
    state.enrollConfig = cfgReply.iaconfig;
    return `group ${g.id}, token ${t.token.id}`;
  });

  await run.step('P4 enroll: two devices with possession proofs; a third is refused; a bad proof / forged config is refused', async () => {
    state.A = new SimDevice(s(), 'SMOKE-PC-A', SERVICE_FEATURES_A);
    state.B = new SimDevice(s(), 'SMOKE-PC-B', SERVICE_FEATURES_B);
    const forged = state.enrollConfig.replace('"groupId":"', '"groupId":"0');
    eq((await rawPost('/api/v1/devices/enroll', state.A.enrollBody(forged, state.enrollToken.id))).json?.error?.code, 'invalid_enroll_config', 'a tampered enroll.iaconfig');
    const bad = state.A.enrollBody(state.enrollConfig, state.enrollToken.id);
    bad.deviceKeyProof = state.B.sign(new Uint8Array([1, 2, 3]));
    eq((await rawPost('/api/v1/devices/enroll', bad)).json?.error?.code, 'token_bad_signature', 'a proof by another key');
    for (const dev of [state.A, state.B]) {
      const r = await rawPost('/api/v1/devices/enroll', dev.enrollBody(state.enrollConfig, state.enrollToken.id));
      eq(r.status, 201, `enroll ${dev.name}`);
      check(s().deviceEnrollReplySchema.safeParse(r.json).success, 'enroll reply matches the contract schema');
      eq(r.json.keyId, dev.keyId, 'keyId = kidOf(devicePublicKey)');
      eq(r.json.group?.id, state.group.id, 'group from the signed config');
      eq(r.json.policy.mode, 'allow', 'effective policy (group override)');
      dev.deviceId = r.json.deviceId;
      state.deviceSignalUrl = cfg.signalUrlOverride ? cfg.signalUrlOverride.replace(/\/signal$/, '/signal/device') : r.json.signalUrl;
    }
    const third = new SimDevice(s(), 'SMOKE-PC-C', SERVICE_FEATURES_B);
    const r3 = await rawPost('/api/v1/devices/enroll', third.enrollBody(state.enrollConfig, state.enrollToken.id));
    check(r3.status === 410 && ['token_used', 'token_gone'].includes(r3.json?.error?.code), `third enrollment answers 410 token_used/token_gone (got ${r3.status} ${r3.json?.error?.code})`);
    const tok = await api.expect('GET', `/api/v1/tokens/${state.enrollToken.id}`);
    eq(tok.devicesEnrolled, 2, 'devicesEnrolled');
    eq(tok.status, 'used', 'an exhausted enrollment token is used');
    return `A ${state.A.deviceId}, B ${state.B.deviceId}`;
  });

  await run.step('P4 /signal/device: Origin -> 403; desk.hello on it -> 4403; bad signature -> 4412; signed hello -> hello.ok', async () => {
    const withOrigin = new SignalClient('device-origin', state.deviceSignalUrl, { Origin: cfg.webOrigin });
    let refused = false;
    try {
      await withOrigin.open(T);
    } catch (err) {
      refused = /HTTP 403/.test(err.message);
    }
    check(refused, 'an upgrade with an Origin header is refused 403');
    const rogue = new SignalClient('device-rogue', state.deviceSignalUrl, { 'User-Agent': SERVICE_UA });
    ctx.sockets.push(rogue);
    await rogue.open(T);
    assertDeviceFrame(s(), await rogue.next('device.challenge', T));
    rogue.send({ t: 'desk.hello', token: 'ia1.x' });
    eq((await rogue.next('error', T)).code, 'forbidden', 'desk.hello on /signal/device');
    eq((await rogue.waitClose(T)).code, 4403, 'close code');
    const forger = await state.A.connect(ctx, { badSig: true, expectError: true });
    eq((await forger.next('error', T)).code, 'device_unauthenticated', 'a bad hello signature');
    eq((await forger.waitClose(T)).code, 4412, 'close 4412');
    const okA = await state.A.connect(ctx);
    eq(okA.deviceId, state.A.deviceId, 'hello.ok deviceId');
    eq(okA.policy.mode, 'allow', 'hello.ok policy');
    eq(okA.queued.length, 0, 'nothing queued yet');
    const dev = await api.expect('GET', `/api/v1/devices/${state.A.deviceId}`);
    eq(dev.online, true, 'GET /devices/:id folds online from presence');
    eq(dev.interactive?.state, 'locked', 'interactive');
    check(dev.firstSeenAt, 'firstSeenAt set by the first hello');
    return `device A online (${okA.orgDisplayName})`;
  });

  await run.step('P4 session: refusals first (no reason 400, attended + nobody present 409), then unattended -> device.session_open auto_grant', async () => {
    const assist = new SignalClient('assist', cfg.signalUrl, { Origin: cfg.webOrigin, Cookie: api.cookie });
    ctx.sockets.push(assist);
    await assist.open(T);
    assist.send({ t: 'assist.hello' });
    await assist.reply('assist.hello.ok', T);
    state.assist = assist;
    const path = `/api/v1/devices/${state.A.deviceId}/sessions`;
    eq((await api.request('POST', path, { unattended: true })).status, 400, 'unattended without a reason');
    eq((await api.request('POST', path, { unattended: false })).json?.error?.code, 'nobody_present', 'attended to a locked device');
    const r = await api.expect('POST', path, { unattended: true, reason: 'smoke: patch the print spooler' }, [201]);
    state.sessionId = r.sessionId;
    const open = assertDeviceFrame(s(), await state.A.ws.next('device.session_open', T));
    eq(open.sessionId, r.sessionId, 'device.session_open sessionId');
    eq(open.decision, 'auto_grant', 'decision (allow + nobody present)');
    eq(open.unattended, true, 'unattended');
    state.workerCredential = open.workerCredential;
    eq((await api.request('POST', path, { unattended: true, reason: 'again' })).json?.error?.code, 'device_busy', 'one live session per device');
    return `session ${r.sessionId}`;
  });

  await run.step('P4 session: assist.resume attaches the console (session.created carries device + unattended); the worker joins with its single-use credential', async () => {
    const { assist } = state;
    assist.send({ t: 'assist.resume', sessionId: state.sessionId });
    const created = assertServerFrame(s(), await assist.reply('session.created', T));
    eq(created.tier, 'p4_installed', 'tier');
    eq(created.tokenId, null, 'a device session has no token');
    eq(created.unattended, true, 'unattended');
    // Sections 6.2 / 13.2: the console learns the policy this session opened under, not the device's current policy.
    eq(created.policySnapshot?.mode, 'allow', 'session.created.policySnapshot.mode');
    eq(created.policySnapshot?.recordingRequired, false, 'session.created.policySnapshot is the effective snapshot');
    eq(created.device?.publicKey, state.A.publicKey, 'session.created.device.publicKey');
    eq(s().kidOf(s().base64urlDecode(created.device.publicKey)), created.device.keyId, 'kidOf(publicKey) === keyId');
    state.created = created;
    const worker = new SignalClient('worker', cfg.signalUrl, { 'User-Agent': WORKER_UA });
    ctx.sockets.push(worker);
    await worker.open(T);
    worker.send({ t: 'desk.hello', workerCredential: state.workerCredential, client: workerClient(['screen', 'input', 'input_text', 'chat', 'files']) });
    const ok = assertServerFrame(s(), await worker.reply('desk.hello.ok', T));
    eq(ok.tokenId, null, 'desk.hello.ok tokenId');
    const deskCreated = assertServerFrame(s(), await worker.reply('session.created', T));
    eq(deskCreated.device?.id, state.A.deviceId, 'desk copy carries the device');
    state.worker = worker;
    const replay = new SignalClient('worker-replay', cfg.signalUrl, { 'User-Agent': WORKER_UA });
    ctx.sockets.push(replay);
    await replay.open(T);
    replay.send({ t: 'desk.hello', workerCredential: state.workerCredential, client: workerClient(['screen']) });
    eq((await replay.next('error', T)).code, 'unauthenticated', 'a spent worker credential');
    eq((await replay.waitClose(T)).code, 4401, 'close 4401');
  });

  await run.step('P4 session: auto_grant consent -> active; session.unattended_started chained; device_attest verified and sec.verified { method: device_key }', async () => {
    const { worker, assist } = state;
    worker.send({ t: 'desk.consent', state: 'granted', surface: 'monitor', native: { level: 'control', monitors: [1], clipboard: false } });
    eq((await worker.reply('consent.ok', T)).state, 'active', 'consent.ok');
    eq((await assist.reply('consent.changed', T)).level, 'control', 'console learns control');
    // Rule 3.5b: the worker asks the service to sign the SAS + fingerprints; the console verifies with the device key.
    const sas = String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
    const deskFpr = randomBytes(32).toString('hex');
    const assistFpr = randomBytes(32).toString('hex');
    const input = s().deviceSigInput.sas({ sessionId: state.sessionId, gen: 0, sas, deskFpr, assistFpr });
    const attest = { t: 'ctl.event', kind: 'device_attest', gen: 0, sig: state.A.sign(input), ts: Date.now() };
    check(s().agentControlEventSchema.safeParse(attest).success, 'ctl.event device_attest matches the schema');
    check(s().verifyDeviceSignature(input, attest.sig, state.created.device.publicKey), 'the console verifies the attestation with session.created.device.publicKey');
    await api.expect('POST', `/api/v1/sessions/${state.sessionId}/events`, { action: 'sec.verified', data: { sas, gen: 0, method: 'device_key' } }, [201]);
    const audit = await api.expect('GET', `/api/v1/sessions/${state.sessionId}/audit`);
    const by = (a) => audit.items.find((e) => e.action === a);
    eq(by('session.knock')?.actor.type, 'system', 'session.knock actor');
    eq(by('session.knock')?.data.deviceId, state.A.deviceId, 'session.knock P4 branch');
    eq(by('session.accepted')?.data.unattended, true, 'session.accepted P4 branch');
    eq(by('session.unattended_started')?.data.approvedBy, 'policy', 'session.unattended_started approvedBy');
    eq(by('session.unattended_started')?.data.reason, 'smoke: patch the print spooler', 'typed reason chained');
    eq(by('sec.verified')?.data.method, 'device_key', 'sec.verified method');
    // Section 6.3 exposed on REST: the snapshot and who authorised it, on the session and in the device's history.
    const rest = await api.expect('GET', `/api/v1/sessions/${state.sessionId}`);
    eq(rest.approvedBy, 'policy', 'GET /sessions/:id approvedBy');
    eq(rest.policySnapshot?.mode, 'allow', 'GET /sessions/:id policySnapshot');
    const dev = await api.expect('GET', `/api/v1/devices/${state.A.deviceId}`);
    const recent = dev.recentSessions.find((x) => x.id === state.sessionId);
    eq(recent?.approvedBy, 'policy', 'device detail recentSessions approvedBy');
    eq(recent?.policySnapshot?.mode, 'allow', 'device detail recentSessions policySnapshot');
    const v = verifySessionAudit(s(), audit.items, { orgId: state.org.id, sessionId: state.sessionId, region: state.region, requiredActions: ['session.knock', 'session.accepted', 'session.started', 'session.unattended_started'] });
    check(v.ok, `session chain: ${v.problems.join('; ')}`);
    return `SAS ${sas} attested by the device key`;
  });

  await run.step('P4 session: privileged mode in place (elevation.granted { mode: service }); input lock attested; end -> device.receipt', async () => {
    const { worker, assist } = state;
    worker.send({ t: 'desk.consent_level', sessionId: state.sessionId, level: 'elevated', requested: true, opId: 'e4e4e4e4e4e4e4e4' });
    eq((await worker.reply('consent.level_ok', T)).level, 'elevated', 'consent.level_ok elevated');
    eq((await assist.reply('consent.changed', T)).level, 'elevated', 'console learns elevated');
    worker.send({ t: 'desk.event', sessionId: state.sessionId, action: 'input.lock_changed', data: { locked: true, cause: 'technician' } });
    await worker.reply('event.ok', T);
    // Rule 6.2a: someone sits down mid-session; the console is told, not left to find out at the receipt.
    worker.send({ t: 'desk.event', sessionId: state.sessionId, action: 'session.local_user_arrived', data: { decision: 'continue', levelDroppedTo: 'view' } });
    await worker.reply('event.ok', T);
    const arrived = assertServerFrame(s(), await assist.next('session.local_user_arrived', T));
    eq(arrived.sessionId, state.sessionId, 'session.local_user_arrived sessionId');
    eq(arrived.decision, 'continue', 'session.local_user_arrived decision');
    eq(arrived.levelDroppedTo, 'view', 'session.local_user_arrived levelDroppedTo');
    assist.send({ t: 'session.end', sessionId: state.sessionId, note: 'smoke done' });
    eq((await assist.reply('session.ended', T)).endReason, 'assist_ended', 'session.ended');
    const rc = assertDeviceFrame(s(), await state.A.ws.next('device.receipt', T));
    eq(rc.receipt.sessionId, state.sessionId, 'receipt sessionId');
    eq(rc.receipt.approvedBy, 'policy', 'receipt approvedBy');
    eq(rc.receipt.elevation.granted, true, 'receipt elevation');
    eq(rc.receipt.inputLock.length, 1, 'receipt input lock window');
    eq(rc.receipt.localUserArrived.length, 1, 'receipt records the arrival');
    const audit = await api.expect('GET', `/api/v1/sessions/${state.sessionId}/audit`);
    eq(audit.items.find((e) => e.action === 'elevation.granted')?.data.mode, 'service', 'elevation.granted mode');
    const sent = audit.items.filter((e) => e.action === 'consent.receipt_sent').map((e) => e.data.channel).sort();
    eq(JSON.stringify(sent), JSON.stringify(['device', 'email']), 'consent.receipt_sent per channel');
  });

  await run.step('P4 offline queue: a message queued while offline is delivered in hello.ok.queued; signed running/done chained', async () => {
    state.A.ws.close();
    await state.A.ws.waitClose(T);
    await new Promise((r) => setTimeout(r, 300));
    const q = await api.expect('POST', `/api/v1/devices/${state.A.deviceId}/actions`, { kind: 'message', payload: { title: 'IT', body: 'We will connect shortly' } }, [202]);
    eq(q.state, 'queued', 'an offline device queues the action');
    const ok = await state.A.connect(ctx);
    const item = ok.queued.find((a) => a.id === q.actionId);
    check(item, 'the queued action is in device.hello.ok.queued');
    eq(item.state, 'dispatched', 'delivered as dispatched');
    for (const st of ['running', 'done']) {
      const result = st === 'done' ? { exit: 0 } : undefined;
      const body = { actionId: q.actionId, state: st, approvedBy: 'policy', ...(result ? { result } : {}) };
      const sig = state.A.sign(s().deviceSigInput.action({ deviceId: state.A.deviceId, ...body }));
      state.A.ws.send({ t: 'device.action_result', ...body, sig });
    }
    state.A.ws.send({ t: 'device.action_result', actionId: q.actionId, state: 'failed', sig: s().base64urlEncode(new Uint8Array(64)) });
    eq((await state.A.ws.next('error', T)).code, 'device_bad_signature', 'an unsigned result is rejected');
    const rc = assertDeviceFrame(s(), await state.A.ws.next((m) => m.t === 'device.receipt' && m.receipt.actionId === q.actionId, T, 'action receipt'));
    eq(rc.receipt.state, 'done', 'action receipt state');
    const list = await api.expect('GET', `/api/v1/devices/${state.A.deviceId}/actions`);
    const row = list.items.find((a) => a.id === q.actionId);
    eq(row?.state, 'done', 'action state');
    eq(row?.approvedBy, 'policy', 'approvedBy');
    const chain = await api.expect('GET', `/api/v1/audit?limit=200`);
    const acts = chain.items.filter((e) => e.data?.actionId === q.actionId).map((e) => `${e.action}:${e.actor.type}`);
    for (const want of ['device.action_queued:user', 'device.action_dispatched:system', 'device.action_started:device', 'device.action_completed:device'])
      check(acts.includes(want), `chain has ${want} (got ${acts.join(', ')})`);
    return `action ${q.actionId}`;
  });

  await run.step('P4 vault: a vault-backed action is read at dispatch only, sealed to the one device, or fails vault_unavailable honestly', async () => {
    const refs = [{ env: 'IA_SMOKE_SECRET', path: 'smoke/api-key' }];
    const pb = await api.expect(
      'POST',
      '/api/v1/orgs/current/playbooks',
      { name: `Smoke vault rotate ${randomBytes(3).toString('hex')}`, interpreter: 'cmd', body: 'echo rotating the key', vaultRefs: refs },
      [201],
    );
    eq(JSON.stringify(pb.vaultRefs), JSON.stringify(refs), 'the catalogue entry keeps its vaultRefs (rule 9.8)');
    const path = `/api/v1/devices/${state.A.deviceId}/actions`;
    const payload = { playbookId: pb.id, args: {}, requiresElevation: false };
    eq((await api.request('POST', path, { kind: 'playbook_run', payload })).status, 400, 'a vault-backed run needs a typed reason');
    // Queue it while the device is away: the vault must not be read at queue time, so no secret may rest in the row.
    state.A.ws.close();
    await state.A.ws.waitClose(T);
    await new Promise((r) => setTimeout(r, 300));
    const q = await api.expect('POST', path, { kind: 'playbook_run', payload, reason: 'smoke: rotate the API key' }, [202]);
    eq(q.state, 'queued', 'queued while the device is offline');
    const queued = (await api.expect('GET', path)).items.find((a) => a.id === q.actionId);
    check(queued && !JSON.stringify(queued).includes('sealed'), 'the queued row carries no sealed secret');
    const ok = await state.A.connect(ctx);
    check(!ok.queued.some((a) => a.id === q.actionId), 'a vault-backed action is not delivered inside hello.ok.queued');
    let frame = null;
    try {
      frame = assertDeviceFrame(s(), await state.A.ws.next((m) => m.t === 'device.action' && m.actionId === q.actionId, 2000, 'device.action'));
    } catch {
      frame = null;
    }
    const chain = await api.expect('GET', '/api/v1/audit?action=secret.injected&limit=50');
    const injected = chain.items.find((e) => e.data?.actionId === q.actionId);
    if (!frame) {
      // No vault on this node (the usual smoke setup): the action fails rather than running without its secret.
      const row = (await api.expect('GET', path)).items.find((a) => a.id === q.actionId);
      eq(row?.state, 'failed', 'with no vault reachable the action fails');
      eq(row?.result?.error, 'vault_unavailable', 'the honest error of rule 9.8');
      check(!injected, 'nothing is chained as injected when no secret was ever read');
      return 'no vault reachable: failed vault_unavailable (set VAULT_ADDR / VAULT_ROLE_ID / VAULT_SECRET_ID to drive the sealed path)';
    }
    eq(frame.secrets?.length, 1, 'one sealed value per ref, attached at dispatch only');
    eq(frame.secrets[0].env, 'IA_SMOKE_SECRET', 'the env name the playbook declared');
    const value = new TextDecoder().decode(s().openSealed(state.A.kexSecret, state.A.deviceId, 'vault-secret', frame.secrets[0].sealed));
    check(value.length > 0, 'the device opens the sealed secret with its own sealing key');
    let opened = false;
    try {
      s().openSealed(state.B.kexSecret, state.B.deviceId, 'vault-secret', frame.secrets[0].sealed);
      opened = true;
    } catch {
      opened = false;
    }
    check(!opened, 'no other device can open it: sealed to one device');
    check(injected, 'secret.injected chained at dispatch');
    eq(injected.actor.type, 'system', 'secret.injected actor');
    eq(JSON.stringify(injected.data.refs), JSON.stringify(refs), 'the chain records env + path, never the value');
    check(!JSON.stringify(chain.items).includes(value), 'the secret value is never chained');
    return `secret sealed to ${state.A.deviceId} for one use`;
  });

  await run.step('P4 wake: the waker peer opens the sealed MAC, wake.sent; the target reconnects -> device.woke pushed and chained', async () => {
    await state.B.connect(ctx);
    state.A.ws.close();
    await state.A.ws.waitClose(T);
    await new Promise((r) => setTimeout(r, 300));
    const w = await api.expect('POST', `/api/v1/devices/${state.A.deviceId}/wake`, { method: 'auto', reason: 'smoke wake' }, [202]);
    eq(w.method, 'wol', 'resolved method');
    eq(w.via, state.B.deviceId, 'the elected waker is the online peer in the segment');
    const send = assertDeviceFrame(s(), await state.B.ws.next('wake.send', T));
    eq(send.wakeId, w.wakeId, 'wake.send wakeId');
    const mac = new TextDecoder().decode(s().openSealed(state.B.kexSecret, state.B.deviceId, 'wake-mac', send.targetMacSealed));
    eq(mac, state.A.wakeMac, 'the waker opens the target MAC with its sealing key');
    state.B.ws.send({ t: 'wake.sent', wakeId: w.wakeId, ok: true });
    await state.A.connect(ctx);
    const woke = assertServerFrame(s(), await state.assist.next((m) => m.t === 'device.woke' && m.wakeId === w.wakeId, T, 'device.woke'));
    eq(woke.deviceId, state.A.deviceId, 'device.woke deviceId');
    const chain = await api.expect('GET', `/api/v1/audit?limit=200`);
    const acts = chain.items.filter((e) => e.data?.wakeId === w.wakeId).map((e) => e.action).sort();
    eq(JSON.stringify(acts), JSON.stringify(['device.wake_dispatched', 'device.wake_requested', 'device.woke']), 'wake chain');
    return `woke in ${woke.elapsedMs} ms via ${w.via}`;
  });

  await run.step('P4 tamper: a signed device.tamper -> tamper.ok + tamper.alert (actor device), device alerted; acknowledge -> ok', async () => {
    const ev = { id: crypto.randomUUID(), cause: 'stopped', at: new Date().toISOString(), detail: 'service stopped by an administrator' };
    const sig = state.A.sign(s().deviceSigInput.tamper({ deviceId: state.A.deviceId, event: ev }));
    state.A.ws.send({ t: 'device.tamper', events: [{ ...ev, sig }] });
    const ack = assertDeviceFrame(s(), await state.A.ws.reply('device.tamper.ok', T));
    eq(JSON.stringify(ack.ids), JSON.stringify([ev.id]), 'tamper.ok ids');
    eq((await api.expect('GET', `/api/v1/devices/${state.A.deviceId}`)).tamperState, 'alerted', 'tamperState');
    const chain = await api.expect('GET', `/api/v1/audit?action=tamper.alert`);
    const e = chain.items.find((x) => x.data.eventId === ev.id);
    eq(e?.actor.type, 'device', 'tamper.alert actor');
    eq((await api.expect('POST', `/api/v1/devices/${state.A.deviceId}/tamper/acknowledge`, { note: 'smoke' })).tamperState, 'ok', 'acknowledged');
  });

  await run.step('P4 deregister: signed uninstall of B -> 204 deregistered; its socket closes 4412; a replayed nonce is refused', async () => {
    const ts = Date.now();
    const nonce = s().base64urlEncode(new Uint8Array(randomBytes(16)));
    const sig = state.B.sign(s().deviceSigInput.deregister({ deviceId: state.B.deviceId, ts, nonce }));
    eq((await rawPost(`/api/v1/devices/${state.B.deviceId}/deregister`, { ts, nonce, sig })).status, 204, 'deregister');
    eq((await state.B.ws.waitClose(T)).code, 4412, 'the device socket closes 4412');
    eq((await rawPost(`/api/v1/devices/${state.B.deviceId}/deregister`, { ts, nonce, sig })).status, 401, 'a replayed deregister');
    eq((await api.expect('GET', `/api/v1/devices/${state.B.deviceId}`)).status, 'deregistered', 'status');
  });

  await run.step('P4: fleet list, residency counts, org chain verified server-side', async () => {
    const list = await api.expect('GET', '/api/v1/devices?online=true');
    check(list.items.some((d) => d.id === state.A.deviceId), 'device A is listed as online');
    // Section 13.2: a device's own override is readable back, so the console shows "set here" rather than guessing.
    const path = `/api/v1/devices/${state.A.deviceId}`;
    eq((await api.expect('GET', path)).unattendedPolicy, null, 'no override to begin with');
    const override = { maxUnattendedMinutes: 20, recordingRequired: false };
    const patched = (await api.expect('PATCH', path, { unattendedPolicy: override })).unattendedPolicy;
    eq(Object.keys(patched ?? {}).sort().join(','), 'maxUnattendedMinutes,recordingRequired', 'PATCH returns exactly the stored keys');
    const after = await api.expect('GET', path);
    eq(after.unattendedPolicy?.maxUnattendedMinutes, 20, 'GET /devices/:id carries the stored override');
    eq(after.unattendedPolicy?.recordingRequired, false, 'GET /devices/:id carries every stored key');
    eq(after.policy.maxUnattendedMinutes, 20, 'the effective policy still merges it');
    eq((await api.expect('PATCH', path, { unattendedPolicy: null })).unattendedPolicy, null, 'the override is cleared, not emptied');
    const res = await api.expect('GET', '/api/v1/orgs/current/residency');
    eq(res.devices, 2, 'residency devices');
    check(res.unattendedSessions30d >= 1 && res.wakeAttempts30d >= 1 && res.deviceActions30d >= 1, 'residency fleet counts');
    const v = await api.expect('POST', '/api/v1/audit/verify', {});
    eq(v.ok, true, 'org chain verifies');
    return `${v.checked} entries verified`;
  });
}
