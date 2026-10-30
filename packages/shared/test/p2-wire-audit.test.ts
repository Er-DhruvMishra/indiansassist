/** Phase B additions to the WS, REST and audit schemas (section 13.1 shared rows). */
import { describe, expect, it } from 'vitest';
import {
  AUDIT_ACTIONS,
  assistEventDataSchema,
  auditDataSchema,
  BUCKET_EXEMPT_TYPES,
  DATA_CHANNEL_LABELS,
  DEFAULT_EXTENSION_POLICY,
  deskEventDataSchema,
  DESK_CLIENT_TYPES,
  ASSIST_CLIENT_TYPES,
  hostToHash,
  P1_DATA_CHANNEL_LABELS,
  parseClientSignal,
  parseServerSignal,
  publicTokenSchema,
  recordingFileExtension,
  recordingMediaType,
  recordingMetaSchema,
  sessionEventRequestSchema,
} from '../src/index.js';

const SID = '00000000-0000-4000-8000-000000000001';
const OP = '0123456789abcdef';
const H = 'a'.repeat(64);
const client = (m: Record<string, unknown>) => parseClientSignal(JSON.stringify(m));

describe('signaling P2 messages', () => {
  it('desk.hello client and desk.consent extension', () => {
    const ext = { kind: 'extension', version: '0.2.0', browser: { name: 'chrome', version: '131' }, os: 'windows' };
    expect(client({ t: 'desk.hello', token: 'x', client: ext }).ok).toBe(true);
    expect(client({ t: 'desk.hello', token: 'x', client: { kind: 'extension' } }).ok).toBe(false);
    expect(client({ t: 'desk.hello', token: 'x', client: { ...ext, browser: { name: 'chrome', version: '123456789' } } }).ok).toBe(false);
    expect(client({ t: 'desk.hello', token: 'x', client: { kind: 'web' } }).ok).toBe(true);
    expect(client({ t: 'desk.consent', state: 'granted', surface: 'browser', extension: { level: 'tab_control', scope: 'current_tab', backstage: false } }).ok).toBe(true);
    expect(client({ t: 'desk.consent', state: 'granted', extension: { level: 'root', scope: 'current_tab', backstage: false } }).ok).toBe(false);
  });

  it('consent level / backstage, offer restart and stats additions', () => {
    expect(client({ t: 'desk.consent_level', sessionId: SID, level: 'in_page', requested: true, opId: OP }).ok).toBe(true);
    expect(client({ t: 'desk.consent_backstage', sessionId: SID, backstage: true }).ok).toBe(true);
    expect(client({ t: 'webrtc.offer', sessionId: SID, sdp: 'v=0', restart: true }).ok).toBe(true);
    expect(parseServerSignal({ t: 'consent.level_ok', sessionId: SID, level: 'view', backstage: false }).ok).toBe(true);
    expect(parseServerSignal({ t: 'consent.changed', sessionId: SID, state: 'granted', surface: 'browser', level: 'view', scope: 'all_tabs', backstage: true }).ok).toBe(true);
    const created = {
      t: 'session.created', sessionId: SID, tokenId: SID, tier: 'p2_extension', state: 'consent_pending', consentState: 'pending',
      assist: { id: SID, name: 'A' }, desk: { label: 'D' }, org: { displayName: 'O', accentColor: null, logoData: null }, polite: false,
      extension: { policy: { ...DEFAULT_EXTENSION_POLICY } },
    };
    expect(parseServerSignal(created).ok).toBe(true);
    const stats = { t: 'session.stats', sessionId: SID, path: 'p2p', rttMs: 1, codec: null, bitrateKbps: null, fps: null, width: null, height: null, packetsLost: null, ts: 1, mirrorKbps: 42, mirrorTransport: 'relay' };
    expect(client(stats).ok).toBe(true);
  });

  it('mirror.relay json refinement and limits; control.relay validates msg', () => {
    const base = { t: 'mirror.relay', sessionId: SID, tabId: 3, seq: 1, kind: 'batch', enc: 'deflate', part: 1, parts: 2, data: 'AAAA' };
    expect(client(base).ok).toBe(true);
    expect(client({ ...base, part: 3 }).ok).toBe(false);
    expect(client({ ...base, parts: 257 }).ok).toBe(false);
    expect(client({ ...base, data: 'A'.repeat(40961) }).ok).toBe(false);
    expect(client({ ...base, data: 'not base64url!' }).ok).toBe(false);
    expect(client({ ...base, kind: 'json', tabId: 0, seq: 0, enc: 'none', parts: 1 }).ok).toBe(true);
    expect(client({ ...base, kind: 'json' }).ok).toBe(false);
    const ctl = { t: 'control.relay', sessionId: SID, msg: { t: 'ctl.req', id: 'r1', op: 'tabs.list', args: {}, ts: 1 } };
    expect(client(ctl).ok).toBe(true);
    expect(client({ ...ctl, msg: { t: 'ctl.req', id: 'r1', op: 'Runtime.evaluate', args: {}, ts: 1 } }).ok).toBe(false);
  });

  it('desk.event: per-action data, reason only where allowed, no Hash keys from clients', () => {
    const ev = (action: string, data: unknown, extra: Record<string, unknown> = {}) => client({ t: 'desk.event', sessionId: SID, action, data, ...extra });
    expect(ev('tab.action', { kind: 'tabs.navigate', opId: OP, tabId: 4, host: 'example.com', ok: true }).ok).toBe(true);
    expect(ev('tab.action', { kind: 'tabs.navigate', opId: OP, tabId: 4, hostHash: H, ok: true }).ok).toBe(false);
    expect(ev('tab.action', { kind: 'tabs.navigate', opId: OP, host: 'Example.com:8080', ok: true }).ok).toBe(false);
    expect(ev('mask.refused', { tabId: 1, scope: 'field', nodeId: 3, opId: OP, cause: 'timeout' }, { reason: 'why' }).ok).toBe(true);
    expect(ev('mirror.started', { reason: 'consent', scope: 'current_tab', level: 'view', tabCount: 1 }, { reason: 'x' }).ok).toBe(false);
    expect(ev('file.sent', { fileId: 1, direction: 'desk_to_assist', name: 'a.txt', bytes: 1, sha256: H }).ok).toBe(true);
    expect(ev('mask.requested', { tabId: 1, scope: 'tab', opId: OP }).ok).toBe(false);
  });

  it('client type lists and bucket exemptions', () => {
    expect(DESK_CLIENT_TYPES).toEqual(expect.arrayContaining(['desk.consent_level', 'desk.consent_backstage', 'mirror.relay', 'control.relay']));
    expect(ASSIST_CLIENT_TYPES).toEqual(expect.arrayContaining(['mirror.relay', 'control.relay']));
    expect(BUCKET_EXEMPT_TYPES).toEqual(['ping', 'pong', 'session.end', 'desk.consent']);
    expect(DATA_CHANNEL_LABELS).toEqual(['ia.chat', 'ia.annot', 'ia.file', 'ia.ctrl', 'ia.mirror', 'ia.control', 'ia.sec', 'ia.playbook']);
    expect(P1_DATA_CHANNEL_LABELS).toHaveLength(4);
  });
});

describe('audit P2 actions', () => {
  it('every new action is registered', () => {
    for (const a of ['mirror.started', 'tab.action', 'mask.override', 'consent.level_changed', 'mirror.relayed', 'org.policy_updated', 'recording.deleted', 'control.refused'])
      expect(AUDIT_ACTIONS).toContain(a);
  });
  it('wire has host, chain has hostHash, neither accepts the other', () => {
    const wire = { kind: 'tabs.create', opId: OP, tabId: 9, host: 'example.com', ok: true };
    expect(deskEventDataSchema('tab.action').safeParse(wire).success).toBe(true);
    expect(auditDataSchema('tab.action').safeParse(wire).success).toBe(false);
    const mapped = hostToHash(wire, (h) => `${h}`.length.toString(16).padStart(64, '0'));
    expect(mapped.host).toBe('example.com');
    expect(mapped.data).not.toHaveProperty('host');
    expect(auditDataSchema('tab.action').safeParse(mapped.data).success).toBe(true);
    expect(deskEventDataSchema('tab.action').safeParse(mapped.data).success).toBe(false);
    expect(hostToHash({ kind: 'tabs.pin', opId: OP }, () => H)).toEqual({ data: { kind: 'tabs.pin', opId: OP }, host: null });
  });
  it('console and desk shapes both fit the chain', () => {
    expect(assistEventDataSchema('control.input').safeParse({ mode: 'dom', tabId: 1, count: 3, kinds: ['pointer'], windowMs: 10000 }).success).toBe(true);
    expect(auditDataSchema('control.input').safeParse({ mode: 'dom', tabId: 1, count: 3, kinds: ['pointer'], windowMs: 10000, refused: 0 }).success).toBe(true);
    expect(auditDataSchema('control.input').safeParse({ mode: 'dom', tabId: 1, count: 3, kinds: ['pointer', 'pointer'], windowMs: 1 }).success).toBe(false);
    expect(auditDataSchema('backstage.exit').safeParse({ tabId: 1, outcome: 'closed', durationMs: 5 }).success).toBe(true);
    expect(auditDataSchema('backstage.exit').safeParse({ tabId: 1, action: 'keep', opId: OP }).success).toBe(true);
    expect(auditDataSchema('session.consent_granted').parse({ surface: 'browser', level: 'in_page', scope: 'all_tabs', backstage: true })).toMatchObject({ level: 'in_page' });
    expect(auditDataSchema('control.refused').safeParse({ op: 'input.key', opId: OP, required: 'in_page', granted: 'view', transport: 'relay' }).success).toBe(true);
  });
});

describe('REST P2 additions', () => {
  it('session events accept the console actions', () => {
    expect(sessionEventRequestSchema.safeParse({ action: 'tab.action', data: { kind: 'tabs.close', opId: OP, tabIds: [1, 2] } }).success).toBe(true);
    expect(sessionEventRequestSchema.safeParse({ action: 'level.requested', data: { level: 'in_page', opId: OP }, reason: 'help' }).success).toBe(true);
    expect(sessionEventRequestSchema.safeParse({ action: 'tab.action', data: { kind: 'tabs.close', opId: OP, tabIds: [1] }, reason: 'x' }).success).toBe(false);
    expect(sessionEventRequestSchema.safeParse({ action: 'backstage.enter', data: { hostHash: H, opId: OP } }).success).toBe(false);
  });
  it('rrweb recording mime has no codecs and a jsonl.gz extension', () => {
    expect(recordingMediaType('application/x-ia-rrweb+jsonl')).toBe('application/x-ia-rrweb+jsonl');
    expect(recordingMediaType('application/x-ia-rrweb+jsonl; codecs=x')).toBeNull();
    expect(recordingMediaType('video/webm;codecs=vp9')).toBe('video/webm');
    expect(recordingFileExtension('application/x-ia-rrweb+jsonl')).toBe('jsonl.gz');
    expect(recordingMetaSchema.safeParse({ mime: 'application/x-ia-rrweb+jsonl' }).success).toBe(true);
    expect(recordingMetaSchema.safeParse({ mime: 'application/json' }).success).toBe(false);
  });
  it('PublicToken.extension', () => {
    const pt = {
      tokenId: SID, tier: 'p2_extension', typ: 'timed', expiresAt: '2026-10-23T00:00:00.000Z', region: 'in-mum',
      org: { displayName: 'O', logoData: null, accentColor: null, supportEmail: null }, technician: null, signalUrl: 'ws://x/signal', joinSupported: true,
      extension: { ids: [], webStoreUrl: null, edgeAddonsUrl: null, minVersion: '0.2.0' },
    };
    expect(publicTokenSchema.safeParse(pt).success).toBe(true);
    expect(publicTokenSchema.safeParse({ ...pt, extension: null }).success).toBe(true);
  });
});
