/**
 * P3 console controller end to end against an in-process fake agent: the `ia.sec` handshake with the shared
 * SecHandshake on both ends, encrypted ia.control / ia.playbook frames, the SAS gate per key generation, input ops
 * only in Control, elevation and playbook reporting, a rebuild (`restart`, `gen`) and the `sec:` failure path, and
 * the orderly end (A section 7.4 hard rule 2: the Desk closes its channels before its own end frame, which must win).
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
    peerEndFallbackMs: 200,
    channelCloseGraceMs: 100,
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

const sessionEnded = (endReason: string) => ({
  t: 'session.ended',
  sessionId: IDS.session,
  endReason,
  endedAt: LATER,
  startedAt: LATER,
  durationMs: 1000,
  hashChainTail: null,
  assist: { id: IDS.user, name: 'Anil K' },
  surface: 'monitor',
  recordingStarted: false,
  reachedActive: true,
});

/** Lets the deferred close decision (one macrotask) and any async failure path run. */
const settle = () => new Promise((r) => setTimeout(r, 20));

/** The Desk's hard rule 2 teardown as the console sees it: every channel closes. */
function deskTeardown(d: Desk) {
  for (const ch of d.chans.values()) ch.close();
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
    ctrl.confirmSas(d.hs.result!.sas); // C9: playbooks and elevation need the confirmed security code
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

  it('stop.sharing then the channel closes is an orderly end: ended desk_stopped, no sec.failed, no sec: end', async () => {
    const d = await live();
    deskSend(d, 'ia.ctrl', { t: 'stop.sharing', ts: 1 });
    deskTeardown(d);
    expect(ctrl.snapshot.phase).toBe('ending');
    expect(ctrl.snapshot.notice).toMatch(/stopped sharing/);
    expect(FakePeerConnection.instances[0]!.closed).toBe(true);
    await settle();
    expect(ctrl.snapshot.sec.state).toBe('established');
    expect(ctrl.snapshot.error).toBeNull();
    ws.receive(sessionEnded('desk_stopped'));
    expect(ctrl.snapshot.phase).toBe('ended');
    expect(ctrl.snapshot.ended?.endReason).toBe('desk_stopped');
    await new Promise((r) => setTimeout(r, 250));
    expect(reports.some((r) => r.action === 'sec.failed')).toBe(false);
    expect(ws.ofType('session.end')).toHaveLength(0);
  });

  it("stop.sharing { reason: 'indicator_failed' } says the Desk's indicator could not be shown, then ends as the Desk's error", async () => {
    const d = await live();
    deskSend(d, 'ia.ctrl', { t: 'stop.sharing', ts: 1, reason: 'indicator_failed' });
    deskTeardown(d);
    expect(ctrl.snapshot.phase).toBe('ending');
    expect(ctrl.snapshot.notice).toMatch(/on-screen indicator could not be shown/);
    await settle();
    expect(ctrl.snapshot.sec.state).toBe('established');
    // The Desk's own `session.end { note: 'indicator_lost' }` comes back as `error` (C W21).
    ws.receive(sessionEnded('error'));
    expect(ctrl.snapshot.phase).toBe('ended');
    expect(ctrl.snapshot.ended?.endReason).toBe('error');
    expect(reports.some((r) => r.action === 'sec.failed')).toBe(false);
  });

  it('a close on another channel in the same tick as stop.sharing is decided after the message (no sec.fail)', async () => {
    const d = await live();
    d.chans.get('ia.control')!.close();
    d.chans.get('ia.file')!.close();
    deskSend(d, 'ia.ctrl', { t: 'stop.sharing', ts: 1 });
    await settle();
    expect(reports.some((r) => r.action === 'sec.failed')).toBe(false);
    expect(ws.ofType('session.end')).toHaveLength(0);
    expect(ctrl.snapshot.phase).toBe('ending');
    expect(d.hs.state).toBe('established');
  });

  it('a mid-session channel close without a stop message is sec.fail channel (step 9)', async () => {
    const d = await live();
    d.chans.get('ia.control')!.close();
    await vi.waitFor(() => expect(ws.ofType('session.end')).toHaveLength(1));
    expect(ws.ofType('session.end')[0]!['note']).toBe('sec:channel');
    expect(reports.find((r) => r.action === 'sec.failed')?.data).toEqual({ reason: 'channel' });
    expect(ctrl.snapshot.sec).toMatchObject({ state: 'failed', failReason: 'channel' });
    expect(d.hs.state).toBe('failed');
    expect(FakePeerConnection.instances[0]!.closed).toBe(true);
  });

  it('consent.revoked then the channel closes ends as consent_revoked, with no sec.failed', async () => {
    const d = await live();
    deskSend(d, 'ia.ctrl', { t: 'consent.revoked', ts: 1 });
    deskTeardown(d);
    await settle();
    ws.receive({ t: 'consent.changed', sessionId: IDS.session, state: 'revoked' });
    ws.receive(sessionEnded('consent_revoked'));
    expect(ctrl.snapshot.phase).toBe('ended');
    expect(ctrl.snapshot.ended?.endReason).toBe('consent_revoked');
    expect(reports.some((r) => r.action === 'sec.failed')).toBe(false);
    expect(ws.ofType('session.end')).toHaveLength(0);
  });

  it('closes after session.ended or our own End are teardown, not a channel violation', async () => {
    const d = await live();
    await ctrl.endSession();
    deskTeardown(d);
    await settle();
    expect(ws.ofType('session.end')).toEqual([expect.objectContaining({ sessionId: IDS.session })]);
    expect(ws.ofType('session.end')[0]!['note']).toBeUndefined();
    expect(reports.some((r) => r.action === 'sec.failed')).toBe(false);
  });

  it('a close after the connection failed is not a channel violation (the rule applies while it lives)', async () => {
    const d = await live();
    FakePeerConnection.instances[0]!.setConnectionState('failed');
    d.chans.get('ia.control')!.close();
    await settle();
    expect(reports.some((r) => r.action === 'sec.failed')).toBe(false);
    expect(ws.ofType('session.end')).toHaveLength(0);
  });

  it('after a stop message without session.ended the console falls back to a plain session.end', async () => {
    const d = await live();
    deskSend(d, 'ia.ctrl', { t: 'stop.sharing', ts: 1 });
    deskTeardown(d);
    await settle();
    expect(ws.ofType('session.end')).toHaveLength(0);
    await vi.waitFor(() => expect(ws.ofType('session.end')).toHaveLength(1));
    expect(ws.ofType('session.end')[0]!['note']).toBe('peer:desk_stopped');
    expect(reports.some((r) => r.action === 'sec.failed')).toBe(false);
  });

  it('skip is refused while the org requires the confirmation', async () => {
    await live();
    expect(ctrl.skipSas()).toBe(false);
  });

  // ---------- C2: the SAS gate is reset on every link and the generation must advance monotonically ----------

  it('refuses a restart offer that replays the confirmed generation and keeps Control blocked (C2)', async () => {
    const d0 = await live();
    ctrl.confirmSas(d0.hs.result!.sas);
    expect(ctrl.setInputMode('control')).toBe(true);
    // A forged / replayed restart offer at the same generation must not reuse the gen-0 confirmation.
    ws.receive({ t: 'webrtc.offer', sessionId: IDS.session, sdp: 'v=0 replay', restart: true, gen: 0 });
    await vi.waitFor(() => expect(ws.ofType('session.end')).toHaveLength(1));
    expect(ws.ofType('session.end')[0]!['note']).toBe('sec:commit');
    expect(reports.find((r) => r.action === 'sec.failed')?.data).toEqual({ reason: 'commit' });
    expect(ctrl.setInputMode('control')).toBe(false);
    expect(FakePeerConnection.instances[0]!.closed).toBe(true);
  });

  it('refuses a restart offer that carries no generation after one was confirmed (C2)', async () => {
    const d0 = await live();
    ctrl.confirmSas(d0.hs.result!.sas);
    ws.receive({ t: 'webrtc.offer', sessionId: IDS.session, sdp: 'v=0 nogen', restart: true });
    await vi.waitFor(() => expect(ws.ofType('session.end')).toHaveLength(1));
    expect(ws.ofType('session.end')[0]!['note']).toBe('sec:commit');
    expect(reports.find((r) => r.action === 'sec.failed')?.data).toEqual({ reason: 'commit' });
    expect(ctrl.setInputMode('control')).toBe(false);
  });

  // ---------- C9: playbooks, cancel and elevation share the control + SAS gate ----------

  it('does not run a playbook, cancel a run, or request elevation before the SAS is confirmed (C9)', async () => {
    const d = await live();
    expect(await ctrl.runPlaybook(ctrl.snapshot.playbooks[0]!, {})).toMatch(/security code/i);
    expect(await ctrl.requestElevation('install the printer driver')).toBe(false);
    await ctrl.cancelPlaybook('c'.repeat(32));
    await settle();
    expect(d.inbox.some((m) => m['op'] === 'playbook.run')).toBe(false);
    expect(d.inbox.some((m) => m['op'] === 'elevation.request')).toBe(false);
    expect(d.inbox.some((m) => m['op'] === 'playbook.cancel')).toBe(false);
    expect(reports.some((r) => r.action === 'elevation.requested')).toBe(false);
    expect(ctrl.snapshot.runs).toHaveLength(0);
    expect(ctrl.snapshot.sasPrompt).toBe(true);
  });

  // ---------- C13: chat.channel_open and WS chat forgery defence ----------

  it('announces chat.channel_open on establish and drops a WS chat.message once ia.chat is open (C13)', async () => {
    const d = await live();
    expect(ws.ofType('chat.channel_open')).toHaveLength(1);
    ws.receive({ t: 'chat.message', sessionId: IDS.session, msgId: IDS.other, from: 'desk', text: 'forged', ts: 1 });
    expect(ctrl.snapshot.chat.some((c) => c.text === 'forged')).toBe(false);
    deskSend(d, 'ia.chat', { t: 'chat', msgId: IDS.token, from: 'desk', text: 'real', ts: 2 });
    expect(ctrl.snapshot.chat.some((c) => c.text === 'real')).toBe(true);
  });

  it('accepts the WS chat.message relay only while ia.chat is not yet open (C13)', async () => {
    ws.receive({ t: 'chat.message', sessionId: IDS.session, msgId: IDS.other, from: 'desk', text: 'early', ts: 1 });
    expect(ctrl.snapshot.chat.some((c) => c.text === 'early')).toBe(true);
    await live();
    ws.receive({ t: 'chat.message', sessionId: IDS.session, msgId: IDS.token, from: 'desk', text: 'late', ts: 2 });
    expect(ctrl.snapshot.chat.some((c) => c.text === 'late')).toBe(false);
  });

  // ---------- F9: a server-initiated end racing the Desk's P2P close is not a channel violation ----------

  it('waits out the channel-close grace for a server-initiated session.ended (no sec.fail channel) (F9)', async () => {
    const d = await live();
    vi.useFakeTimers();
    try {
      // The Desk tears its P2P down (a channel closes) before the server's session.ended reaches the console.
      d.chans.get('ia.control')!.close();
      await vi.advanceTimersByTimeAsync(50); // still inside the 100 ms grace
      expect(reports.some((r) => r.action === 'sec.failed')).toBe(false);
      ws.receive(sessionEnded('timeout')); // the real end arrives: the link is torn down and the grace timer cleared
      await vi.advanceTimersByTimeAsync(200); // past the original grace deadline
      expect(reports.some((r) => r.action === 'sec.failed')).toBe(false);
      expect(ws.ofType('session.end')).toHaveLength(0);
      expect(ctrl.snapshot.phase).toBe('ended');
      expect(ctrl.snapshot.ended?.endReason).toBe('timeout');
    } finally {
      vi.useRealTimers();
    }
  });
});
