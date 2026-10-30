/**
 * Phase C wire additions: native `desk.hello`, `desk.consent.native`, the new D->S / S->D messages, `consent.changed`
 * monitors / clipboard, annotations with `monitorId`, the P3 audit actions (wire vs chain), the family rule and the
 * native control ops on `ia.control`.
 */
import { describe, expect, it } from 'vitest';
import {
  AGENT_CONTROL_OPS,
  CONTROL_OPS,
  DESK_CLIENT_TYPES,
  RESERVED_AUDIT_ACTIONS,
  agentInputKind,
  agentLevelAtLeast,
  agentStatsSchema,
  auditDataSchema,
  consentLevelFamily,
  controlEventSchema,
  controlInputMonitorId,
  dcAnnotSchema,
  deskClientSchema,
  levelAtLeast,
  parseClientSignal,
  parseDataChannelMessage,
  parseServerSignal,
  sessionEventRequestSchema,
} from '../src/index.js';

const SID = '6f1c3a2e-8b7d-4c5e-9f10-a1b2c3d4e5f6';
const NATIVE = {
  kind: 'native',
  version: '0.3.0',
  os: 'windows',
  platform: { osVersion: '10.0.26100', arch: 'x64' },
  tokenSource: 'filename',
  capabilities: { monitors: 2, elevation: 'user', features: ['screen', 'elevation'], encoders: ['vp8'], hwEncoder: false, interpreters: ['powershell', 'cmd'] },
};

describe('desk.hello native', () => {
  it('a native client needs platform, tokenSource, capabilities and os windows | android', () => {
    expect(deskClientSchema.safeParse(NATIVE).success).toBe(true);
    expect(deskClientSchema.safeParse({ ...NATIVE, os: 'android' }).success).toBe(true);
    expect(deskClientSchema.safeParse({ ...NATIVE, os: 'linux' }).success).toBe(false);
    const { capabilities: _c, ...noCaps } = NATIVE;
    void _c;
    expect(deskClientSchema.safeParse(noCaps).success).toBe(false);
    expect(deskClientSchema.safeParse({ ...NATIVE, browser: { name: 'chrome', version: '131' } }).success).toBe(false);
    expect(deskClientSchema.safeParse({ kind: 'web', os: 'android' }).success).toBe(false);
    expect(deskClientSchema.safeParse({ kind: 'web', tokenSource: 'manual' }).success).toBe(false);
  });
  it('desk.hello carries handover; desk.hello.ok carries resumeKey', () => {
    expect(parseClientSignal({ t: 'desk.hello', token: 'x', handover: 'h'.repeat(43), client: NATIVE }).ok).toBe(true);
    expect(parseClientSignal({ t: 'desk.hello', token: 'x', handover: 'h'.repeat(257) }).ok).toBe(false);
    const ok = { t: 'desk.hello.ok', connectionId: 'c', tokenId: SID, tier: 'p3_portable', technician: null, org: { displayName: 'O', logoData: null, accentColor: null }, region: 'in-mum', resumeKey: 'k' };
    expect(parseServerSignal(ok).ok).toBe(true);
  });
});

describe('P3 consent and new messages', () => {
  it('desk.consent.native validates monitors and level', () => {
    const base = { t: 'desk.consent', state: 'granted', surface: 'monitor' };
    expect(parseClientSignal({ ...base, native: { level: 'control', monitors: [1, 2], clipboard: false } }).ok).toBe(true);
    expect(parseClientSignal({ ...base, native: { level: 'control', monitors: [], clipboard: false } }).ok).toBe(false);
    expect(parseClientSignal({ ...base, native: { level: 'control', monitors: [1, 1], clipboard: false } }).ok).toBe(false);
    expect(parseClientSignal({ ...base, native: { level: 'in_page', monitors: [1], clipboard: false } }).ok).toBe(false);
    expect(parseClientSignal({ ...base, native: { level: 'control', monitors: [17], clipboard: false } }).ok).toBe(false);
  });
  it('the new D->S messages are Desk types; S->D messages parse', () => {
    for (const t of ['desk.consent_clipboard', 'desk.consent_monitors', 'desk.elevation']) expect(DESK_CLIENT_TYPES).toContain(t);
    expect(parseClientSignal({ t: 'desk.consent_clipboard', sessionId: SID, clipboard: true }).ok).toBe(true);
    expect(parseClientSignal({ t: 'desk.consent_monitors', sessionId: SID, monitors: [1, 3] }).ok).toBe(true);
    expect(parseClientSignal({ t: 'desk.elevation', sessionId: SID, opId: 'abcdef0123456789' }).ok).toBe(true);
    expect(parseClientSignal({ t: 'desk.elevation', sessionId: SID, opId: 'xyz' }).ok).toBe(false);
    expect(parseServerSignal({ t: 'elevation.handover', sessionId: SID, handover: 'h', expiresAt: '2026-10-30T00:00:00.000Z' }).ok).toBe(true);
    expect(parseServerSignal({ t: 'session.handed_over', sessionId: SID }).ok).toBe(true);
    expect(parseServerSignal({ t: 'consent.changed', sessionId: SID, state: 'granted', surface: 'monitor', level: 'control', monitors: 2, clipboard: false }).ok).toBe(true);
    expect(parseServerSignal({ t: 'consent.level_ok', sessionId: SID, level: 'elevated', backstage: false, clipboard: true }).ok).toBe(true);
    expect(parseClientSignal({ t: 'webrtc.offer', sessionId: SID, sdp: 'v=0', restart: true, gen: 1 }).ok).toBe(true);
  });
  it('session.created.agent carries the manifest; session.stats the agent fields', () => {
    const pb = { id: SID, name: 'n', description: '', interpreter: 'cmd', requiresElevation: false, parameters: [], timeoutSec: 30, bodyHash: 'a'.repeat(64) };
    const created = {
      t: 'session.created', sessionId: SID, tokenId: SID, tier: 'p3_portable', state: 'consent_pending', consentState: 'pending',
      assist: { id: SID, name: 'A' }, desk: { label: 'D' }, org: { displayName: 'O', logoData: null, accentColor: null }, polite: false,
      agent: { playbooks: [pb], truncated: true },
    };
    expect(parseServerSignal(created).ok).toBe(true);
    expect(parseServerSignal({ ...created, agent: { playbooks: [{ ...pb, body: 'x' }] } }).ok).toBe(false);
    const stats = { t: 'session.stats', sessionId: SID, path: 'p2p', rttMs: 5, codec: 'VP8', bitrateKbps: 1, fps: 30, width: 1, height: 1, packetsLost: 0, ts: 1, encoder: 'vp8', floorMode: true, capturePath: 'projection', encodeMs: 4, glassMs: 80, monitorsStreaming: 1 };
    expect(parseClientSignal(stats).ok).toBe(true);
  });
  it('agent.stats rides ia.ctrl (projection, rung null)', () => {
    const s = { t: 'agent.stats', encoder: 'vp8', hwEncoder: true, capturePath: 'projection', rung: null, floorMode: false, targetKbps: 1, sentKbps: 1, recorderKbps: null, captureFps: 5, sentFps: 5, encodeMs: null, monitors: [{ id: 1, width: 1, height: 1, fps: 5 }], cpuPercent: null, ts: 1 };
    expect(agentStatsSchema.safeParse(s).success).toBe(true);
    expect(parseDataChannelMessage('ia.ctrl', JSON.stringify(s)).ok).toBe(true);
  });
  it('annotations carry monitorId; ia.sec carries the handshake only', () => {
    expect(dcAnnotSchema.safeParse({ t: 'annot', shape: 'clear', ts: 1, monitorId: 2 }).success).toBe(true);
    expect(dcAnnotSchema.safeParse({ t: 'annot', shape: 'clear', ts: 1, monitorId: 0 }).success).toBe(false);
    expect(parseDataChannelMessage('ia.sec', JSON.stringify({ t: 'sec.fail', reason: 'timeout', ts: 1 })).ok).toBe(true);
    expect(parseDataChannelMessage('ia.sec', JSON.stringify({ t: 'chat', msgId: SID, from: 'desk', text: 'x', ts: 1 })).ok).toBe(false);
  });
});

describe('family rule and native ops', () => {
  it('consentLevelFamily; a P3 level never reaches levelAtLeast', () => {
    expect(consentLevelFamily('p3_portable')).toBe('p3');
    expect(consentLevelFamily('p2_extension')).toBe('p2');
    expect(() => levelAtLeast('control' as never, 'view')).toThrow();
    expect(() => agentLevelAtLeast('in_page' as never, 'view')).toThrow();
    expect(agentLevelAtLeast('elevated', 'control')).toBe(true);
  });
  it('P2 and P3 ops are disjoint; native ops parse on ia.control; the prompt event gains elevation and file', () => {
    expect(AGENT_CONTROL_OPS.filter((o) => (CONTROL_OPS as readonly string[]).includes(o))).toEqual(['level.request']);
    const req = { t: 'ctl.req', id: 'r1', op: 'os.pointer', args: { monitorId: 1, kind: 'click', nx: 0.5, ny: 0.5, button: 0, modifiers: { alt: false, ctrl: false, meta: false, shift: false } }, ts: 1 };
    expect(parseDataChannelMessage('ia.control', JSON.stringify(req)).ok).toBe(true);
    expect(parseDataChannelMessage('ia.control', JSON.stringify({ t: 'ctl.event', kind: 'monitors', monitors: [], selected: [], ts: 1 })).ok).toBe(true);
    expect(controlEventSchema.safeParse({ t: 'ctl.event', kind: 'prompt', id: 'r', promptKind: 'elevation', state: 'shown', opId: 'abcdef0123456789', ts: 1 }).success).toBe(true);
    expect(controlEventSchema.safeParse({ t: 'ctl.event', kind: 'prompt', id: 'r', promptKind: 'file', state: 'shown', opId: 'abcdef0123456789', ts: 1 }).success).toBe(true);
  });
  it('controlInputMonitorId and agentInputKind (section 3.8)', () => {
    expect(controlInputMonitorId({ op: 'os.pointer', args: { monitorId: 3 }, lastPointerMonitorId: 1 })).toBe(3);
    expect(controlInputMonitorId({ op: 'os.text', lastPointerMonitorId: 2, viewedMonitorId: 1 })).toBe(2);
    expect(controlInputMonitorId({ op: 'os.key', viewedMonitorId: 4 })).toBe(4);
    expect(controlInputMonitorId({ op: 'os.nav' })).toBe(1);
    expect(agentInputKind('os.nav')).toBe('key');
    expect(agentInputKind('os.text')).toBe('text');
    expect(agentInputKind('clipboard.set')).toBeNull();
  });
});

describe('P3 audit actions', () => {
  it('desk.event P3 actions (control.input os, elevation.denied with reason, playbook.run)', () => {
    const ci = { mode: 'os', monitorId: 2, count: 3, kinds: ['pointer', 'text'], windowMs: 10000, textChars: 5, refused: 0 };
    expect(parseClientSignal({ t: 'desk.event', sessionId: SID, action: 'control.input', data: ci }).ok).toBe(true);
    expect(parseClientSignal({ t: 'desk.event', sessionId: SID, action: 'control.input', data: { ...ci, tabId: 1 } }).ok).toBe(false);
    expect(parseClientSignal({ t: 'desk.event', sessionId: SID, action: 'elevation.denied', data: { opId: 'abcdef0123456789', cause: 'uac_cancelled' }, reason: 'r' }).ok).toBe(true);
    expect(parseClientSignal({ t: 'desk.event', sessionId: SID, action: 'elevation.failed', data: { opId: 'abcdef0123456789', error: 'launch_failed' }, reason: 'r' }).ok).toBe(false);
    const run = { playbookId: SID, bodyHash: 'a'.repeat(64), runId: '0'.repeat(32), opId: 'abcdef0123456789', exit: 0, durationMs: 5, truncated: false, ranAs: 'user' };
    expect(parseClientSignal({ t: 'desk.event', sessionId: SID, action: 'playbook.run', data: run }).ok).toBe(true);
    expect(parseClientSignal({ t: 'desk.event', sessionId: SID, action: 'a11y.state', data: { enabled: true } }).ok).toBe(true);
  });
  it('POST events P3 actions; sec.verified skipped rule', () => {
    const ok = (b: unknown) => sessionEventRequestSchema.safeParse(b).success;
    expect(ok({ action: 'sec.verified', data: { sas: '123456', gen: 0 } })).toBe(true);
    expect(ok({ action: 'sec.verified', data: { sas: null, gen: 1, skipped: true } })).toBe(true);
    expect(ok({ action: 'sec.verified', data: { sas: null, gen: 1 } })).toBe(false);
    expect(ok({ action: 'elevation.requested', data: { opId: 'abcdef0123456789' }, reason: 'install driver' })).toBe(true);
    expect(ok({ action: 'monitor.selected', data: { monitorIds: [1, 2], opId: 'abcdef0123456789' } })).toBe(true);
    expect(ok({ action: 'control.input', data: { mode: 'os', monitorId: 1, count: 1, kinds: ['key'], windowMs: 1, textChars: 0 } })).toBe(true);
    expect(ok({ action: 'control.input', data: { mode: 'dom', tabId: 1, count: 1, kinds: ['key'], windowMs: 1 } })).toBe(true);
    expect(ok({ action: 'input.text_burst', data: { chars: 300, windowMs: 10000, monitorId: 1 } })).toBe(true);
  });
  it('chain schemas: elevation.requested is written now; consent_granted P3 shape; reserved list', () => {
    expect(RESERVED_AUDIT_ACTIONS).toEqual(['session.supervisor_joined']);
    expect(auditDataSchema('elevation.requested').safeParse({ opId: 'abcdef0123456789' }).success).toBe(true);
    expect(auditDataSchema('session.consent_granted').safeParse({ surface: 'monitor', level: 'control', monitors: 2, clipboard: false }).success).toBe(true);
    expect(auditDataSchema('session.consent_granted').safeParse({ surface: 'browser', level: 'in_page', scope: 'current_tab', backstage: false }).success).toBe(true);
    expect(auditDataSchema('elevation.granted').safeParse({ opId: 'abcdef0123456789', elevation: 'admin', claimed: true }).success).toBe(true);
    expect(auditDataSchema('download.served').safeParse({ tokenId: SID, platform: 'windows', arch: 'x64', version: '0.3.0', sha256: 'a'.repeat(64) }).success).toBe(true);
    expect(auditDataSchema('consent.level_changed').safeParse({ from: 'control', to: 'elevated', requestedBy: 'assist', opId: 'abcdef0123456789' }).success).toBe(true);
    expect(auditDataSchema('playbook.run_requested').safeParse({ playbookId: SID, bodyHash: 'a'.repeat(64), runId: '0'.repeat(32), opId: 'abcdef0123456789' }).success).toBe(true);
  });
});
