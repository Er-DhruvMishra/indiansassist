// Phase C smoke flow, part 2: the ia.sec handshake (both sides run the shared TS driver in-process, because Node has
// no WebRTC; the signaling and REST parts stay live), the console's security-code confirmation, os input accepted at
// `control` and refused below it with `control.refused`, the elevation request and hand-over on the one_time token,
// a starter playbook run (202 body, encrypted op, pinned-hash check, agent attestation), the end with the chain
// verified client-side, and the download grant (prepare + GET + Range GET).

import { createHash, randomBytes } from 'node:crypto';
import { verifySessionAudit } from './audit.mjs';
import { check, eq } from './runner.mjs';
import { ADMIN_CLIENT, nativeSocket } from './flow-p3.mjs';

const OP_ELEV = 'e1e1e1e1e1e1e1e1';
const OP_LEVEL = 'c0c0c0c0c0c0c0c0';
const MODS = { alt: false, ctrl: false, meta: false, shift: false };

/** Runs the section 1.3 handshake between a desk and an assist driver in-process; returns both drivers. */
function handshake(shared, sessionId, gen) {
  const fd = randomBytes(32).toString('hex');
  const fa = randomBytes(32).toString('hex');
  const toA = [];
  const toD = [];
  const desk = new shared.SecHandshake({ side: 'desk', sessionId, gen, ownFpr: fd, remoteFpr: fa, send: (m) => toA.push(m), timer: false });
  const assist = new shared.SecHandshake({ side: 'assist', sessionId, gen, ownFpr: fa, remoteFpr: fd, send: (m) => toD.push(m), timer: false });
  desk.start();
  assist.start();
  for (let i = 0; i < 10 && (toA.length || toD.length); i++) {
    while (toA.length) assist.receive(JSON.stringify(toA.shift()));
    while (toD.length) desk.receive(JSON.stringify(toD.shift()));
  }
  if (desk.state !== 'established' || assist.state !== 'established')
    throw new Error(`handshake did not establish (desk ${desk.state} ${desk.failReason}, assist ${assist.state} ${assist.failReason})`);
  return { desk, assist };
}

/** Seals `msg` on `label` from the console and opens + parses it on the agent side. */
function overChannel(shared, sec, label, msg) {
  const frame = sec.assist.channel(label).seal(JSON.stringify(msg));
  const opened = sec.desk.channel(label).open(frame);
  const parsed = shared.parseDataChannelMessage(label, opened.text, 'assist');
  if (!parsed.ok) throw new Error(`${label} frame did not parse on the agent side: ${parsed.reason}`);
  return parsed.msg;
}

/** @param {import('./runner.mjs').Runner} run */
export async function p3AgentSteps(run, ctx) {
  const { api, state, cfg, shared } = ctx;
  const T = cfg.timeoutMs;
  const events = (body, ok = [201]) => api.expect('POST', `/api/v1/sessions/${state.sessionId}/events`, body, ok);

  await run.step('P3 ia.sec: commit / hello / confirm in-process, same SAS; sec.verified chained; an encrypted op round-trips', async () => {
    const sec = handshake(shared, state.sessionId, 0);
    eq(sec.desk.result.sas, sec.assist.result.sas, 'both sides derive the same security code');
    check(shared.sasMatches(shared.sasDisplay(sec.desk.result.sas), sec.assist.result.sas), 'console gate compares the code read out');
    await events({ action: 'sec.verified', data: { sas: sec.assist.result.sas, gen: 0 } });
    const req = overChannel(shared, sec, 'ia.control', { t: 'ctl.req', id: 'm1', op: 'os.monitors', args: {}, ts: Date.now() });
    eq(req.op, 'os.monitors', 'decrypted op');
    const resFrame = sec.desk.channel('ia.control').seal(JSON.stringify({ t: 'ctl.res', id: 'm1', ok: true, result: { monitors: [], selected: [1] }, ts: Date.now() }));
    eq(JSON.parse(sec.assist.channel('ia.control').open(resFrame).text).ok, true, 'reply decrypts on the console');
    state.sec = sec;
    return `SAS ${shared.sasDisplay(sec.desk.result.sas)} (gen 0)`;
  });

  await run.step('P3: os input at control is reported by both sides; below control it is refused (403 + control.refused)', async () => {
    const { desk: d, assist, sessionId, sec } = state;
    const pointer = overChannel(shared, sec, 'ia.control', { t: 'ctl.req', id: 'p1', op: 'os.pointer', args: { monitorId: 2, kind: 'click', nx: 0.5, ny: 0.5, button: 0, modifiers: MODS }, ts: Date.now() });
    const monitorId = shared.controlInputMonitorId({ op: pointer.op, args: pointer.args });
    const data = { mode: 'os', monitorId, count: 3, kinds: ['pointer', 'text'], windowMs: 10000, textChars: 5 };
    await events({ action: 'control.input', data });
    d.send({ t: 'desk.event', sessionId, action: 'control.input', data: { ...data, refused: 0 } });
    await d.reply('event.ok', T);
    d.send({ t: 'desk.consent_level', sessionId, level: 'view' });
    eq((await d.reply('consent.level_ok', T)).level, 'view', 'Desk lowers to view');
    eq((await assist.reply('consent.changed', T)).level, 'view', 'console learns view');
    const refused = await api.request('POST', `/api/v1/sessions/${sessionId}/events`, { action: 'control.input', data });
    eq(refused.status, 403, 'control.input above the level');
    eq(refused.json?.error?.details?.granted, 'view', 'refusal names the granted level');
    d.send({ t: 'desk.event', sessionId, action: 'control.input', data: { ...data, count: 0, refused: 2 } });
    await d.reply('event.ok', T);
    d.send({ t: 'desk.consent_level', sessionId, level: 'control', requested: true, opId: OP_LEVEL });
    eq((await d.reply('consent.level_ok', T)).level, 'control', 'Desk allows control again');
    await assist.reply('consent.changed', T);
    return `monitorId ${monitorId}`;
  });

  await run.step('P3: elevation request, hand-over mint, elevated rejoin on the one_time token (4411 + fresh resumeKey)', async () => {
    const { desk: d1, assist, sessionId, sec } = state;
    overChannel(shared, sec, 'ia.control', { t: 'ctl.req', id: 'el1', op: 'elevation.request', args: { reason: 'install the printer driver' }, ts: Date.now() });
    await events({ action: 'elevation.requested', data: { opId: OP_ELEV }, reason: 'install the printer driver' });
    d1.send({ t: 'desk.elevation', sessionId, opId: OP_ELEV });
    const ho = await d1.reply('elevation.handover', T);
    check(typeof ho.handover === 'string' && ho.handover.length >= 43, 'elevation.handover.handover');
    const d2 = nativeSocket(ctx, 'desk-admin');
    await d2.open(T);
    d2.send({ t: 'desk.hello', token: state.compact, handover: ho.handover, client: ADMIN_CLIENT });
    const ok = await d2.reply('desk.hello.ok', T);
    check(typeof ok.resumeKey === 'string', 'desk.hello.ok.resumeKey on a hand-over');
    eq(ok.resume?.state, 'active', 'resume.state');
    await d2.reply('session.created', T);
    await d2.reply('ice.refresh', T);
    await d1.next('session.handed_over', T);
    eq((await d1.waitClose(T)).code, 4411, 'old Desk close code');
    await assist.next('desk.reconnected', T);
    eq((await assist.next('consent.changed', T)).level, 'elevated', 'consent.changed after the hand-over');
    const replay = nativeSocket(ctx, 'desk-replay');
    await replay.open(T);
    replay.send({ t: 'desk.hello', token: state.compact, handover: ho.handover, client: ADMIN_CLIENT });
    eq((await replay.next('error', T)).code, 'forbidden', 'a consumed hand-over is refused');
    state.desk = d2;
    state.sec = handshake(shared, sessionId, 1);
    await events({ action: 'sec.verified', data: { sas: state.sec.assist.result.sas, gen: 1 } });
    return `new SAS ${shared.sasDisplay(state.sec.desk.result.sas)} (gen 1)`;
  });

  await run.step('P3: starter playbook run (202 releases the body; op verbatim; pinned hash; agent attests playbook.run)', async () => {
    const { desk: d, sessionId, sec, manifest } = state;
    const pinned = manifest.find((p) => p.name === 'Flush DNS cache');
    const r = await api.expect('POST', `/api/v1/sessions/${sessionId}/playbooks/${pinned.id}/run`, { args: {}, reason: 'clear stale DNS' }, [202]);
    check(/^[0-9a-f]{32}$/.test(r.runId) && r.opId === shared.opIdFor(sessionId, r.runId), 'runId / opId');
    const op = overChannel(shared, sec, 'ia.control', { t: 'ctl.req', id: r.runId, op: 'playbook.run', args: shared.playbookRunOpArgs(r), ts: Date.now() });
    const bodyHash = createHash('sha256').update(op.args.body, 'utf8').digest('hex');
    check(bodyHash === op.args.bodyHash && bodyHash === pinned.bodyHash, 'sha256(body) === bodyHash === manifest bodyHash (section 8.4)');
    eq(op.id, op.args.runId, 'ctl.req.id === runId');
    const end = sec.desk.channel('ia.playbook').seal(JSON.stringify({ t: 'pb.end', runId: r.runId, exit: 0, durationMs: 140, truncated: false, ranAs: 'user', ts: Date.now() }));
    eq(JSON.parse(sec.assist.channel('ia.playbook').open(end).text).t, 'pb.end', 'pb.end on ia.playbook');
    d.send({ t: 'desk.event', sessionId, action: 'playbook.run', data: { playbookId: pinned.id, bodyHash, runId: r.runId, opId: r.opId, exit: 0, durationMs: 140, truncated: false, ranAs: 'user' } });
    await d.reply('event.ok', T);
    state.run = r;
    return `run ${r.runId}`;
  });

  await run.step('P3: session end by the Desk; the session chain verifies client-side with every Phase C entry', async () => {
    const { desk: d, assist, sessionId } = state;
    d.send({ t: 'session.end', sessionId });
    const ended = await assist.reply('session.ended', T);
    eq(ended.endReason, 'desk_stopped', 'endReason');
    const a = await api.expect('GET', `/api/v1/sessions/${sessionId}/audit`);
    check(a.integrity?.ok === true, `server integrity not ok: ${JSON.stringify(a.integrity?.failure ?? null)}`);
    const v = verifySessionAudit(shared, a.items, {
      orgId: state.org.id,
      sessionId,
      region: state.region,
      requiredActions: ['session.knock', 'session.accepted', 'session.consent_granted', 'session.started', 'elevation.handover_minted', 'elevation.granted', 'session.ended'],
      expectedTail: ended.hashChainTail,
    });
    if (!v.ok) throw new Error(v.problems.join('; '));
    const by = (x) => a.items.filter((e) => e.action === x);
    eq(by('session.consent_granted')[0]?.data?.monitors, 2, 'consent_granted monitors');
    eq(by('sec.verified').length, 2, 'sec.verified per key generation');
    check(by('control.input').some((e) => e.actor.type === 'desk' && e.data.monitorId === 2), 'desk control.input carries monitorId');
    eq(by('control.refused')[0]?.data?.granted, 'view', 'control.refused granted');
    eq(by('elevation.requested')[0]?.reason, 'install the printer driver', 'elevation.requested reason');
    eq(by('elevation.granted')[0]?.data?.claimed, true, 'elevation.granted claimed');
    const pair = a.items.filter((e) => e.data?.opId === state.run.opId).map((e) => `${e.action}:${e.actor.type}`);
    eq(pair.join(','), 'playbook.run_requested:user,playbook.run:desk', 'playbook audit pair by opId');
    return `${v.checked} entries verified`;
  });

  await run.step('P3: download manifest, prepare (desk-code filename), GET 200, HEAD, Range GET 206', async () => {
    const m = await api.expect('GET', '/api/v1/download/manifest');
    const win = (m.builds ?? []).find((b) => b.platform === 'windows' && b.arch === 'x64');
    check(win, 'manifest has a windows x64 build (AGENT_DIST_DIR or the dev stub)');
    const t = await api.expect('POST', '/api/v1/tokens', { tier: 'p3_portable', typ: 'timed', ttlMinutes: 30, label: 'smoke-p3-dl' }, [201]);
    const p = await api.expect('POST', '/api/v1/download/prepare', { code: t.compact, platform: 'windows', arch: 'x64' }, [201]);
    const parsed = shared.parseAgentFileName(p.filename);
    check(parsed && parsed.deskCode === p.deskCode && p.deskCode !== t.token.shortCode, `filename ${p.filename} carries a fresh desk code`);
    const f = ctx.fetchImpl ?? fetch;
    const get1 = await f(p.url);
    eq(get1.status, 200, 'first GET');
    const bytes = Buffer.from(await get1.arrayBuffer());
    eq(createHash('sha256').update(bytes).digest('hex'), p.sha256, 'served bytes hash to the manifest sha256');
    eq((await f(p.url, { method: 'HEAD' })).status, 200, 'HEAD (uncounted)');
    const get2 = await f(p.url, { headers: { Range: 'bytes=0-15' } });
    eq(get2.status, 206, 'Range GET');
    eq(get2.headers.get('content-range'), `bytes 0-15/${bytes.length}`, 'Content-Range');
    return `${p.filename}, ${bytes.length} bytes${win.signed ? '' : ' (unsigned dev build)'}`;
  });
}
