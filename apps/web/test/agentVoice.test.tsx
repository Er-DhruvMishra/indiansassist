/**
 * P3 console voice (docs/specs/phase-c-contracts.md section 6.3): the technician's microphone toggle against an
 * in-process fake agent. getUserMedia only on the click and only once secured, `replaceTrack` on the agent's offered
 * audio transceiver (no second m-line), mute by disabling the track, `voice.state` on the encrypted `ia.ctrl`, the
 * Desk's mic indicator from its own `voice.state`, re-attach after a rebuild, every track stopped at the end, and
 * nothing voice-related without the `voice` capability.
 */
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { P3_DATA_CHANNEL_LABELS, SecHandshake, type AgentCapabilities, type AuthResponse, type SecEncryptedLabel } from '@indiansassist/shared';
import { StaticAuthProvider, type AuthValue } from '../src/auth/AuthContext';
import { AgentConsoleView } from '../src/assist/console/agent/AgentConsole';
import { AgentConsoleController } from '../src/assist/console/agent/agentConsoleController';
import { SignalClient } from '../src/lib/signal';
import { FakePeerConnection, FakeWebSocket, IDS, ISO, LATER, fakeStream, fakeTrack } from './fakes';

const FD = 'd'.repeat(64);
const FA = 'a'.repeat(64);
const VIDEO_AUDIO = 'v=0 desk\nm=video 9 UDP/TLS/RTP/SAVPF 96\nm=audio 9 UDP/TLS/RTP/SAVPF 111';
const VOICE_CAPS: AgentCapabilities = { monitors: 1, elevation: 'user', features: ['screen', 'input', 'chat', 'voice'], encoders: ['vp8'], hwEncoder: false, interpreters: [] };
const NO_VOICE_CAPS: AgentCapabilities = { ...VOICE_CAPS, features: ['screen', 'input', 'chat'] };

class Chan extends EventTarget {
  readyState: RTCDataChannelState = 'connecting';
  binaryType = 'arraybuffer';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onSend: ((d: unknown) => void) | null = null;
  constructor(readonly label: string) {
    super();
  }
  send(d: unknown) {
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
  agent: { playbooks: [] },
  iceServers: [],
  iceTtl: 3600,
  iceExpiresAt: LATER,
};

type Desk = { hs: SecHandshake; chans: Map<string, Chan>; inbox: Record<string, unknown>[] };

let ws: FakeWebSocket;
let signal: SignalClient;
let ctrl: AgentConsoleController;
let mic: ReturnType<typeof fakeTrack>;
let gum: ReturnType<typeof vi.fn>;

/** The agent's seven channels on the latest fake PC and the section 1.3 handshake; returns the Desk side. */
async function connectDesk(gen: number): Promise<Desk> {
  const pc = FakePeerConnection.instances.at(-1)! as unknown as { ondatachannel: ((e: { channel: Chan }) => void) | null };
  const chans = new Map<string, Chan>();
  const inbox: Record<string, unknown>[] = [];
  const hs = new SecHandshake({ side: 'desk', sessionId: IDS.session, gen, ownFpr: FD, remoteFpr: FA, timer: false, send: (m) => queueMicrotask(() => chans.get('ia.sec')!.deliver(JSON.stringify(m))) });
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
  await vi.waitFor(() => expect(hs.state).toBe('established'));
  return { hs, chans, inbox };
}

function deskSend(d: Desk, label: SecEncryptedLabel, msg: unknown) {
  const frame = d.hs.channel(label).seal(JSON.stringify(msg));
  d.chans.get(label)!.deliver(frame.slice().buffer);
}

function makeCtrl(caps: AgentCapabilities) {
  ctrl = new AgentConsoleController({
    signal,
    sessionId: IDS.session,
    RTCPeerConnectionImpl: FakePeerConnection as unknown as typeof RTCPeerConnection,
    fingerprints: () => ({ own: FA, remote: FD }),
    report: async () => undefined,
    loadPolicy: async () => ({ requireSasConfirm: true }),
    peerEndFallbackMs: 200,
    channelCloseGraceMs: 100,
    getUserMedia: gum as never,
  });
  ctrl.start(created as never, true, caps);
}

async function live(sdp = VIDEO_AUDIO, gen = 0): Promise<Desk> {
  if (gen === 0) ws.receive({ t: 'consent.changed', sessionId: IDS.session, state: 'granted', surface: 'monitor', level: 'control', monitors: 1, clipboard: false });
  ws.receive({ t: 'webrtc.offer', sessionId: IDS.session, sdp, ...(gen ? { restart: true, gen } : {}) });
  const d = await connectDesk(gen);
  await vi.waitFor(() => expect(ctrl.snapshot.sec.state).toBe('established'));
  return d;
}

const lastPc = () => FakePeerConnection.instances.at(-1)!;
const audioOf = (pc: FakePeerConnection) => pc.transceivers.find((t) => t.receiver.track.kind === 'audio');
const voiceStates = (d: Desk) => d.inbox.filter((m) => m['t'] === 'voice.state');

beforeEach(() => {
  FakeWebSocket.reset();
  FakePeerConnection.reset();
  signal = new SignalClient({ url: 'ws://x/signal', WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket, latencyPingMs: 0 });
  signal.connect();
  ws = FakeWebSocket.instances[0]!;
  ws.open();
  mic = fakeTrack('audio');
  gum = vi.fn(async () => fakeStream([mic]));
});

afterEach(() => {
  ctrl?.dispose();
  signal.close();
});

describe('P3 console voice (controller)', () => {
  it('answers the agent audio m-line sendrecv; the toggle asks for audio only and attaches it with replaceTrack', async () => {
    makeCtrl(VOICE_CAPS);
    const d = await live();
    const pc = lastPc();
    const audio = audioOf(pc)!;
    expect(audio.direction).toBe('sendrecv');
    expect(gum).not.toHaveBeenCalled();
    await ctrl.toggleVoice();
    expect(gum).toHaveBeenCalledTimes(1);
    expect(gum.mock.calls[0]![0]).toMatchObject({ video: false, audio: expect.anything() });
    expect(audio.sender.replaced).toEqual([mic]);
    // No second audio m-line: addTrack was never used.
    expect(pc.tracks).toHaveLength(0);
    expect(pc.transceivers.filter((t) => t.receiver.track.kind === 'audio')).toHaveLength(1);
    expect(ctrl.snapshot.voiceOn).toBe(true);
    await vi.waitFor(() => expect(voiceStates(d).at(-1)).toMatchObject({ from: 'assist', muted: false }));
  });

  it('toggle off disables the track and sends voice.state muted; toggle on re-enables without a new prompt', async () => {
    makeCtrl(VOICE_CAPS);
    const d = await live();
    await ctrl.toggleVoice();
    await ctrl.toggleVoice();
    expect(mic.enabled).toBe(false);
    expect(mic.stop).not.toHaveBeenCalled();
    expect(ctrl.snapshot.voiceOn).toBe(false);
    await vi.waitFor(() => expect(voiceStates(d).at(-1)).toMatchObject({ from: 'assist', muted: true }));
    await ctrl.toggleVoice();
    expect(mic.enabled).toBe(true);
    expect(gum).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(voiceStates(d).at(-1)).toMatchObject({ muted: false }));
    expect(audioOf(lastPc())!.sender.replaced).toEqual([mic]);
  });

  it('adds the track when the offer has no audio transceiver', async () => {
    makeCtrl(VOICE_CAPS);
    await live('v=0 desk\nm=video 9 UDP/TLS/RTP/SAVPF 96');
    await ctrl.toggleVoice();
    expect(lastPc().tracks).toEqual([mic]);
  });

  it('shows the Desk mic state from its voice.state', async () => {
    makeCtrl(VOICE_CAPS);
    const d = await live();
    expect(ctrl.snapshot.peerMuted).toBeNull();
    deskSend(d, 'ia.ctrl', { t: 'voice.state', from: 'desk', muted: true, ts: 1 });
    expect(ctrl.snapshot.peerMuted).toBe(true);
    deskSend(d, 'ia.ctrl', { t: 'voice.state', from: 'desk', muted: false, ts: 2 });
    expect(ctrl.snapshot.peerMuted).toBe(false);
  });

  it('is gated: no prompt before the channel is secured or without the voice capability', async () => {
    makeCtrl(VOICE_CAPS);
    ws.receive({ t: 'webrtc.offer', sessionId: IDS.session, sdp: VIDEO_AUDIO });
    await ctrl.toggleVoice();
    expect(gum).not.toHaveBeenCalled();
    ctrl.dispose();
    FakePeerConnection.reset();
    makeCtrl(NO_VOICE_CAPS);
    ws.receive({ t: 'webrtc.offer', sessionId: IDS.session, sdp: VIDEO_AUDIO });
    await connectDesk(0);
    await vi.waitFor(() => expect(ctrl.snapshot.sec.state).toBe('established'));
    // Without `voice` the audio m-line is left alone and the toggle does nothing.
    expect(audioOf(lastPc())!.direction).toBe('recvonly');
    await ctrl.toggleVoice();
    expect(gum).not.toHaveBeenCalled();
  });

  it('re-attaches the mic after a rebuild (without stopping it) and tells the Desk again', async () => {
    makeCtrl(VOICE_CAPS);
    await live();
    await ctrl.toggleVoice();
    const first = lastPc();
    const d1 = await live('v=0 rebuilt\nm=video 9 UDP/TLS/RTP/SAVPF 96\nm=audio 9 UDP/TLS/RTP/SAVPF 111', 1);
    const second = lastPc();
    expect(second).not.toBe(first);
    expect(first.closed).toBe(true);
    expect(mic.stop).not.toHaveBeenCalled();
    expect(audioOf(second)!.direction).toBe('sendrecv');
    expect(audioOf(second)!.sender.replaced).toEqual([mic]);
    expect(second.tracks).toHaveLength(0);
    await vi.waitFor(() => expect(voiceStates(d1).at(-1)).toMatchObject({ from: 'assist', muted: false }));
    expect(ctrl.snapshot.voiceOn).toBe(true);
  });

  it('stops every mic track when the session ends', async () => {
    makeCtrl(VOICE_CAPS);
    await live();
    await ctrl.toggleVoice();
    ws.receive({
      t: 'session.ended', sessionId: IDS.session, endReason: 'assist_ended', endedAt: LATER, startedAt: LATER, durationMs: 1000,
      hashChainTail: null, assist: { id: IDS.user, name: 'Anil K' }, surface: 'monitor', recordingStarted: false, reachedActive: true,
    });
    expect(ctrl.snapshot.phase).toBe('ended');
    expect(mic.stop).toHaveBeenCalled();
    expect(ctrl.snapshot.voiceOn).toBe(false);
  });

  it('releases a mic granted after the session ended', async () => {
    makeCtrl(VOICE_CAPS);
    await live();
    let grant: (s: MediaStream) => void = () => undefined;
    gum.mockImplementationOnce(() => new Promise<MediaStream>((r) => (grant = r)));
    const pending = ctrl.toggleVoice();
    void ctrl.endSession();
    grant(fakeStream([mic]));
    await pending;
    expect(mic.stop).toHaveBeenCalled();
    expect(ctrl.snapshot.voiceOn).toBe(false);
  });
});

const me: AuthResponse = {
  user: { id: IDS.user, orgId: IDS.org, email: 'anil@acme.test', name: 'Anil K', role: 'technician', status: 'active', createdAt: ISO, lastLoginAt: ISO },
  org: { id: IDS.org, name: 'Acme', slug: 'acme', dataRegion: 'in-mum', planTier: 'p3_portable', branding: { displayName: 'Acme IT' }, createdAt: ISO },
  seat: null,
};
const auth: AuthValue = { status: 'authenticated', me, error: null, setMe: () => undefined, refresh: () => undefined, logout: async () => undefined };

function renderView() {
  return render(
    <MemoryRouter>
      <StaticAuthProvider value={auth}>
        <AgentConsoleView ctrl={ctrl} sessionId={IDS.session} deskLabel="Rahul" />
      </StaticAuthProvider>
    </MemoryRouter>,
  );
}

describe('P3 console voice (AgentConsole)', () => {
  it('hides every voice control without the voice capability', async () => {
    makeCtrl(NO_VOICE_CAPS);
    renderView();
    expect(screen.queryByRole('region', { name: 'Voice' })).toBeNull();
    expect(screen.queryByRole('button', { name: /microphone/i })).toBeNull();
    expect(document.querySelector('audio')).toBeNull();
  });

  it('greys the toggle until secured, then turns the mic on by click and shows the Desk mic state', async () => {
    makeCtrl(VOICE_CAPS);
    renderView();
    expect(screen.getByRole('button', { name: 'Turn microphone on' })).toHaveProperty('disabled', true);
    expect(document.querySelector('audio')).not.toBeNull();
    let d!: Desk;
    await act(async () => {
      d = await live();
    });
    const btn = screen.getByRole('button', { name: 'Turn microphone on' });
    expect(btn).toHaveProperty('disabled', false);
    await userEvent.click(btn);
    expect(gum).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('button', { name: 'Turn microphone off' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Mute microphone/ })).toBeNull();
    act(() => deskSend(d, 'ia.ctrl', { t: 'voice.state', from: 'desk', muted: false, ts: 1 }));
    expect(screen.getByTestId('peer-voice').textContent).toBe("Rahul's microphone is on");
    act(() => deskSend(d, 'ia.ctrl', { t: 'voice.state', from: 'desk', muted: true, ts: 2 }));
    expect(screen.getByTestId('peer-voice').textContent).toBe('Rahul is muted');
  });
});
