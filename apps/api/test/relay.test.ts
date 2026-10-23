/** Phase B WS relay (section 4.6, Y22, Y25): authorisation, direction rules, limits, level gate, mirror.relayed. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, listen, makeApp, signup, SignalClient, type TestApp } from './helpers.js';
import { licenceP2, OP, P2Kit, patchPolicy, sessionAudit } from './p2-kit.js';

let t: TestApp;
let kit: P2Kit;

beforeAll(async () => {
  t = await makeApp({ MIRROR_RELAY_BUDGET_BYTES: '1000' }, { tickMs: 50 });
  kit = new P2Kit(t, await listen(t.app));
});
afterAll(async () => {
  kit.closeAll();
  await t.close();
});

async function p2Admin() {
  const admin = await signup(t.app);
  await licenceP2(t, admin);
  return admin;
}

const mirror = (sessionId: string, over: Record<string, unknown> = {}) => ({
  t: 'mirror.relay',
  sessionId,
  tabId: 12,
  seq: 1,
  kind: 'batch',
  enc: 'deflate',
  part: 1,
  parts: 1,
  data: 'eJyLjgUAARUAuQ',
  ...over,
});
const req = (op: string, args: Record<string, unknown>, id = 'r1') => ({ t: 'ctl.req', id, op, args, ts: Date.now() });

describe('mirror.relay', () => {
  it('forwards Desk batches to the Assist and json acks back; Assist batches are refused', async () => {
    const admin = await p2Admin();
    const s = await kit.active(admin);
    s.desk.send(mirror(s.sessionId));
    const got = await s.assist.next('mirror.relay');
    expect(got).toMatchObject({ tabId: 12, seq: 1, kind: 'batch', data: 'eJyLjgUAARUAuQ' });
    s.assist.send(mirror(s.sessionId, { kind: 'json', tabId: 0, seq: 0, enc: 'none', data: 'e30' }));
    expect((await s.desk.next('mirror.relay')).kind).toBe('json');
    expect((await s.assist.request(mirror(s.sessionId), 'error')).code).toBe('bad_payload');
  });

  it('drops frames over the per-session budget and counts them; mirror.relayed precedes session.ended', async () => {
    const admin = await p2Admin();
    const s = await kit.active(admin);
    const big = 'A'.repeat(600);
    s.desk.send(mirror(s.sessionId, { data: big }));
    await s.assist.next('mirror.relay');
    const err = await s.desk.request(mirror(s.sessionId, { data: big, seq: 2 }), 'error');
    expect(err).toMatchObject({ code: 'rate_limited' });
    expect((err.details as { retryAfterSec: number }).retryAfterSec).toBeGreaterThanOrEqual(1);
    s.desk.send({ t: 'control.relay', sessionId: s.sessionId, msg: { t: 'ctl.event', kind: 'paused', tabId: 12, paused: true, ts: 1 } });
    await s.assist.next('control.relay');
    s.assist.send({ t: 'session.end', sessionId: s.sessionId });
    await s.assist.next('session.ended');
    const audit = await sessionAudit(t, admin, s.sessionId);
    const actions = audit.items.map((e) => e.action);
    const at = actions.indexOf('mirror.relayed');
    expect(at).toBeGreaterThan(-1);
    expect(actions[at + 1]).toBe('session.ended');
    expect(audit.items[at]!.data).toEqual({ mirrorFrames: 1, mirrorBytes: 600, controlFrames: 1, dropped: 1 });
  });

  it('is refused before active, for P1 sessions and when the org disallows relay', async () => {
    const admin = await p2Admin();
    const p = await kit.pending(admin);
    expect((await p.desk.request(mirror(p.sessionId), 'error')).code).toBe('bad_state');
    expect((await p.desk.request(mirror('00000000-0000-4000-8000-000000000000'), 'error')).code).toBe('forbidden');
    const other = await p2Admin();
    await patchPolicy(t, other, { allowRelayFallback: false });
    const s = await kit.active(other);
    expect((await s.desk.request(mirror(s.sessionId), 'error')).code).toBe('bad_state');
    const ctl = { t: 'control.relay', sessionId: s.sessionId, msg: req('tabs.list', {}) };
    expect((await s.assist.request(ctl, 'error')).code).toBe('bad_state');
  });
});

describe('control.relay', () => {
  it('enforces the direction rule and the 16 KiB cap', async () => {
    const admin = await p2Admin();
    const s = await kit.active(admin);
    s.assist.send({ t: 'control.relay', sessionId: s.sessionId, msg: req('tabs.list', {}) });
    expect((await s.desk.next('control.relay')).msg).toMatchObject({ t: 'ctl.req', op: 'tabs.list' });
    const res = { t: 'ctl.res', id: 'r1', ok: true, result: { tabs: [] }, ts: 1 };
    expect((await s.assist.request({ t: 'control.relay', sessionId: s.sessionId, msg: res }, 'error')).code).toBe('bad_payload');
    expect((await s.desk.request({ t: 'control.relay', sessionId: s.sessionId, msg: req('tabs.list', {}) }, 'error')).code).toBe('bad_payload');
    const huge = { t: 'ctl.res', id: 'r2', ok: true, result: { blob: 'x'.repeat(17000) }, ts: 1 };
    expect((await s.desk.request({ t: 'control.relay', sessionId: s.sessionId, msg: huge }, 'error')).code).toBe('payload_too_large');
    s.desk.send({ t: 'control.relay', sessionId: s.sessionId, msg: res });
    expect((await s.assist.next('control.relay')).msg).toMatchObject({ t: 'ctl.res', ok: true });
  });

  it('refuses requests above the granted level with consent_required and chains control.refused', async () => {
    const admin = await p2Admin();
    const s = await kit.active(admin, { level: 'tab_control', scope: 'current_tab', backstage: false });
    const mods = { alt: false, ctrl: false, meta: false, shift: false };
    const click = req('input.pointer', { tabId: 12, kind: 'click', nodeId: null, vx: 0.5, vy: 0.5, modifiers: mods }, 'click-1');
    const err = await s.assist.request({ t: 'control.relay', sessionId: s.sessionId, msg: click }, 'error');
    expect(err).toMatchObject({ code: 'consent_required', details: { op: 'input.pointer', required: 'in_page', granted: 'tab_control' } });
    expect(await s.desk.quiet('control.relay', 150)).toBe(true);
    const dbg = req('input.mode', { tabId: 12, mode: 'debugger' }, 'mode-1');
    expect((await s.assist.request({ t: 'control.relay', sessionId: s.sessionId, msg: dbg }, 'error')).details).toMatchObject({ required: 'deep_control' });
    // A level the Desk granted passes once raised.
    await s.desk.request({ t: 'desk.consent_level', sessionId: s.sessionId, level: 'in_page', requested: true, opId: OP }, 'consent.level_ok');
    s.assist.send({ t: 'control.relay', sessionId: s.sessionId, msg: { ...click, id: 'click-2' } });
    expect((await s.desk.next('control.relay')).msg).toMatchObject({ op: 'input.pointer' });
    const audit = await sessionAudit(t, admin, s.sessionId);
    const refused = audit.items.filter((e) => e.action === 'control.refused');
    expect(refused.length).toBeGreaterThanOrEqual(1);
    expect(refused[0]).toMatchObject({ actor: { type: 'system' } });
    expect(refused[0]!.data).toMatchObject({ op: 'input.pointer', required: 'in_page', granted: 'tab_control', transport: 'relay' });
    expect(refused[0]!.data.opId).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('frame bucket exemptions (Y25)', () => {
  it('ping and desk.consent do not consume the connection bucket', async () => {
    const limited = await makeApp({ RATE_LIMIT_DISABLED: 'false' }, { tickMs: 50 });
    try {
      const url = await listen(limited.app);
      const c = await SignalClient.open(url);
      for (let i = 0; i < 90; i++) c.send({ t: 'ping' });
      await new Promise((r) => setTimeout(r, 300));
      expect(c.messages.filter((m) => m.t === 'error')).toHaveLength(0);
      for (let i = 0; i < 80; i++) c.send({ t: 'desk.poll' });
      const err = await c.next('error', (m) => m.code === 'rate_limited');
      expect(err.code).toBe('rate_limited');
      c.close();
      const res = await call(limited.app, '/api/v1/health');
      expect(res.statusCode).toBe(200);
    } finally {
      await limited.close();
    }
  });
});
