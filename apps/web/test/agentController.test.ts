/**
 * P3 console controller end to end against an in-process fake agent: the `ia.sec` handshake with the shared
 * SecHandshake on both ends, encrypted ia.control / ia.playbook frames, the SAS gate per key generation, input ops
 * only in Control, elevation and playbook reporting, a rebuild (`restart`, `gen`) and the `sec:` failure path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { P3_DATA_CHANNEL_LABELS, SecHandshake, type SecEncryptedLabel } from '@indiansassist/shared';
import { AgentConsoleController } from '../src/assist/console/agent/agentConsoleController';
import { SignalClient } from '../src/lib/signal';
import { FakePeerConnection, FakeWebSocket, IDS, LATER } from './fakes';

const FD = 'd'.repeat(64);
const FA = 'a'.repeat(64);
const MODS = { alt: false, ctrl: false, meta: false, shift: false };

class Chan extends EventTarget {
  readyState: RTCDataChannelState = 'connecting';
  binaryType = 'arraybuffer';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  onmessage: ((e: MessageEvent) => void) | null = null;
  sent: unknown[] = [];
  onSend: ((d: unknown) => void) | null = null;
  constructor(readonly label: string) {
    super();
  }
  send(d: unknown) {
    this.sent.push(d);
    this.onSend?.(d);
  }
  close() {
    this.readyState = 'closed';
    this.dispatchEvent(new Event('close'));
  }
  open() {
    this.readyState = 'open';
    this.dispatchEvent(new Event('open'));
  }
  deliver(data: unknown) {
    this.onmessage?.({ data } as MessageEvent);
  }
}

const created = {
  t: 'session.created',
  sessionId: IDS.session,
  tokenId: IDS.token,
  tier: 'p3_portable',
  state: 'consent_pending',
  consentState: 'pending',
  assist: { id: IDS.user, name: 'Anil K' },
  desk: { label: 'Rahul' },
  org: { displayName: 'Acme IT', accentColor: null, logoData: null },
  polite: true,
  agent: { playbooks: [{ id: IDS.other, name: 'Flush DNS', description: '', interpreter: 'cmd', requiresElevation: false, parameters: [], timeoutSec: 30, bodyHash: 'b'.repeat(64) }] },
  iceServers: [],
  iceTtl: 3600,
  iceExpiresAt: LATER,
};

let ws: FakeWebSocket;
let signal: SignalClient;
let reports: { action: string; data: Record<string, unknown>; reason?: string }[];
let ctrl: AgentConsoleController;

type Desk = { hs: SecHandshake; chans: Map<string, Chan>; inbox: Record<string, unknown>[] };

/** Builds the agent's seven channels on the latest fake PC and runs the handshake; returns the Desk side. */
async function connectDesk(gen: number, deskRemote = FA): Promise<Desk> {
  const pc = FakePeerConnection.instances.at(-1)! as unknown as { ondatachannel: ((e: { channel: Chan }) => void) | null };
  const chans = new Map<string, Chan>();
  const inbox: Record<string, unknown>[] = [];
  const hs = new SecHandshake({ side: 'desk', sessionId: IDS.session, gen, ownFpr: FD, remoteFpr: deskRemote, timer: false, send: (m) => queueMicrotask(() => chans.get('ia.sec')!.deliver(JSON.stringify(m))) });
  for (const label of P3_DATA_CHANNEL_LABELS) {
    const ch = new Chan(label);
    chans.set(label, ch);
    ch.onSend = (d) => {
      if (label === 'ia.sec') queueMicrotask(() => hs.receive(d as string));
      else if (hs.state === 'established') {
        const o = hs.channel(label as SecEncryptedLabel).open(d as Uint8Array);
        if (o.text) inbox.push(JSON.parse(o.text) as Record<string, unknown>);
      }
    };
    pc.ondatachannel?.({ channel: ch });
  }
  for (const ch of chans.values()) ch.open();
  hs.start();
  await vi.waitFor(() => expect(hs.state === 'established' || hs.state === 'failed').toBe(true));
  return { hs, chans, inbox };
}

function deskSend(d: Desk, label: SecEncryptedLabel, msg: unknown) {
  const frame = d.hs.channel(label).seal(JSON.stringify(msg));
  d.chans.get(label)!.deliver(frame.slice().buffer);
}

beforeEach(() => {
  FakeWebSocket.reset();
  FakePeerConnection.reset();
  signal = new SignalClient({ url: 'ws://x/signal', WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket, latencyPingMs: 0 });
  signal.connect();
  ws = FakeWebSocket.instances[0]!;
  ws.open();
  reports = [];
  ctrl = new AgentConsoleController({
    signal,
    sessionId: IDS.session,
    RTCPeerConnectionImpl: FakePeerConnection as unknown as typeof RTCPeerConnection,
    fingerprints: () => ({ own: FA, remote: FD }),
    report: async (b) => {
      reports.push(b);
    },
    loadPolicy: async () => ({ requireSasConfirm: true }),
    runPlaybook: async (_s, playbookId, args) => ({
      runId: 'c'.repeat(32),
      opId: '0123456789abcdef',
      playbookId,
      body: 'ipconfig /flushdns',
      bodyHash: 'b'.repeat(64),
      interpreter: 'cmd',
      requiresElevation: false,
      timeoutSec: 30,
      args: Object.fromEntries(Object.entries(args).map(([k, v]) => [k, String(v)])),
    }),
  });
  ctrl.start(created as never, true, { monitors: 2, elevation: 'user', features: ['screen', 'multi_monitor', 'input', 'clipboard', 'elevation', 'playbooks'], encoders: ['vp8'], hwEncoder: false, interpreters: ['cmd'] });
});

afterEach(() => {
  ctrl.dispose();
  signal.close();
});

async function live(gen = 0): Promise<Desk> {
  ws.receive({ t: 'consent.changed', sessionId: IDS.session, state: 'granted', surface: 'monitor', level: 'control', monitors: 2, clipboard: true });
  ws.receive({ t: 'webrtc.offer', sessionId: IDS.session, sdp: 'v=0 desk\nm=video 9 UDP/TLS/RTP/SAVPF 96', ...(gen ? { restart: true, gen } : {}) });
  const d = await connectDesk(gen);
  await vi.waitFor(() => expect(ctrl.snapshot.sec.state).toBe('established'));
  return d;
}

describe('AgentConsoleController', () => {
  it('secures the channels, shows the SAS, gates Control until the code is confirmed', async () => {
    expect(ctrl.snapshot.playbooks).toHaveLength(1);
    const d = await live();
    expect(ctrl.snapshot.sec.sas).toBe(d.hs.result!.sas);
    expect(ctrl.snapshot.phase).toBe('live');
    expect(ctrl.setInputMode('control')).toBe(false);
    expect(ctrl.snapshot.sasPrompt).toBe(true);
    const wrong = d.hs.result!.sas === '000000' ? '111111' : '000000';
    expect(ctrl.confirmSas(wrong).result).toBe('wrong');
    expect(ctrl.confirmSas(d.hs.result!.sas).result).toBe('ok');
    expect(reports.find((r) => r.action === 'sec.verified')?.data).toEqual({ sas: d.hs.result!.sas, gen: 0 });
    expect(ctrl.setInputMode('control')).toBe(true);
    ctrl.pointer(2, 'down', 0.25, 0.5, 0, MODS);
    await vi.waitFor(() => expect(d.inbox.some((m) => m['op'] === 'os.pointer')).toBe(true));
    const req = d.inbox.find((m) => m['op'] === 'os.pointer')!;
    expect(req['args']).toMatchObject({ monitorId: 2, kind: 'down', nx: 0.25, ny: 0.5 });
  });

  it('applies monitors / agent_level events and never sends input in View', async () => {
    const d = await live();
    deskSend(d, 'ia.control', { t: 'ctl.event', kind: 'monitors', ts: 1, selected: [1], monitors: [
      { id: 1, name: 'A', primary: true, x: 0, y: 0, width: 1920, height: 1080, scale: 1, mid: '0' },
      { id: 2, name: 'B', primary: false, x: 1920, y: 0, width: 1280, height: 1024, scale: 1.25, mid: '1' },
    ] });
    deskSend(d, 'ia.control', { t: 'ctl.event', kind: 'agent_level', level: 'control', clipboard: true, elevation: 'user', ts: 2 });
    expect(ctrl.snapshot.monitors).toHaveLength(2);
    expect(ctrl.snapshot.agentLevel?.elevation).toBe('user');
    ctrl.pointer(1, 'click', 0.5, 0.5, 0, MODS);
    ctrl.typeText('abc');
    expect(d.inbox.filter((m) => m['op'] === 'os.pointer' || m['op'] === 'os.text')).toHaveLength(0);
    void ctrl.view('all');
    await vi.waitFor(() => expect(d.inbox.some((m) => m['op'] === 'os.monitor.select')).toBe(true));
    expect(reports.find((r) => r.action === 'monitor.selected')?.data['monitorIds']).toEqual([1, 2]);
  });

  it('reports elevation.requested with the reason before the op; runs a playbook verbatim from the 202', async () => {
    const d = await live();
    void ctrl.requestElevation('install the printer driver');
    await vi.waitFor(() => expect(d.inbox.some((m) => m['op'] === 'elevation.request')).toBe(true));
    const rep = reports.find((r) => r.action === 'elevation.requested')!;
    expect(rep.reason).toBe('install the printer driver');
    deskSend(d, 'ia.control', { t: 'ctl.event', kind: 'elevation', opId: rep.data['opId'], state: 'uac_shown', ts: 3 });
    expect(ctrl.snapshot.elevation?.state).toBe('uac_shown');

    void ctrl.runPlaybook(ctrl.snapshot.playbooks[0]!, {});
    await vi.waitFor(() => expect(d.inbox.some((m) => m['op'] === 'playbook.run')).toBe(true));
    const run = d.inbox.find((m) => m['op'] === 'playbook.run')!;
    expect(run['id']).toBe('c'.repeat(32));
    expect((run['args'] as Record<string, unknown>)['body']).toBe('ipconfig /flushdns');
    deskSend(d, 'ia.playbook', { t: 'pb.output', runId: 'c'.repeat(32), stream: 'stdout', seq: 0, chunk: 'Flushed.', ts: 4 });
    deskSend(d, 'ia.playbook', { t: 'pb.end', runId: 'c'.repeat(32), exit: 0, durationMs: 10, truncated: false, ranAs: 'user', ts: 5 });
    expect(ctrl.snapshot.runs[0]).toMatchObject({ stdout: 'Flushed.', end: { exit: 0, ranAs: 'user' } });
  });

  it('a restart offer with gen 1 rebuilds the link, drops to View and re-arms the SAS modal', async () => {
    const d0 = await live();
    ctrl.confirmSas(d0.hs.result!.sas);
    ctrl.setInputMode('control');
    ws.receive({ t: 'webrtc.offer', sessionId: IDS.session, sdp: 'v=0 rebuilt', restart: true, gen: 1 });
    expect(FakePeerConnection.instances).toHaveLength(2);
    expect(FakePeerConnection.instances[0]!.closed).toBe(true);
    expect(ctrl.snapshot.inputMode).toBe('view');
    const d1 = await connectDesk(1);
    await vi.waitFor(() => expect(ctrl.snapshot.sec.gen).toBe(1));
    expect(ctrl.snapshot.sec.state).toBe('established');
    expect(ctrl.snapshot.sasPrompt).toBe(true);
    expect(ctrl.setInputMode('control')).toBe(false);
    expect(ctrl.snapshot.sasHistory.map((h) => h.gen)).toEqual([0, 1]);
    expect(d1.hs.result!.sas).toBe(ctrl.snapshot.sec.sas);
  });

  it('a fingerprint mismatch writes sec.failed and ends the session with note sec:<reason>', async () => {
    ws.receive({ t: 'consent.changed', sessionId: IDS.session, state: 'granted', surface: 'monitor', level: 'view', monitors: 1, clipboard: false });
    ws.receive({ t: 'webrtc.offer', sessionId: IDS.session, sdp: 'v=0 desk' });
    await connectDesk(0, 'e'.repeat(64));
    await vi.waitFor(() => expect(ws.ofType('session.end')).toHaveLength(1));
    expect(ws.ofType('session.end')[0]!['note']).toMatch(/^sec:/);
    expect(reports.some((r) => r.action === 'sec.failed')).toBe(true);
  });

  it('skip is refused while the org requires the confirmation', async () => {
    await live();
    expect(ctrl.skipSas()).toBe(false);
  });
});
