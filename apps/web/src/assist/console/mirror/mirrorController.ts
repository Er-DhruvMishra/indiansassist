/**
 * P2 console controller (Phase B 3, 4.6, 10): the `MirrorConsole` counterpart of `AssistConsoleController`. Same
 * signaling, chat, voice, files and end-session behaviour (shared base), plus the extension specifics: consent
 * level / scope / backstage from `consent.changed`, the mirror and control planes, the WS relay fallback, the P2
 * resume rule (a `desk.reconnected { active }` keeps everything; a `webrtc.offer { restart }` rebuilds only the
 * peer connection), the mirror recording and the P2 `session.stats` fields.
 */
import {
  DEFAULT_EXTENSION_POLICY,
  base64urlEncode,
  isConsentLevel,
  mergePolicy,
  utf8Encode,
  type ConsentLevel,
  type ControlRequest,
  type ExtensionPolicy,
  type MirrorScope,
  type SessionCreated,
  type SessionEnded,
} from '@indiansassist/shared';
import { errorMessage } from '../../../lib/api';
import { sessionsApi } from '../../../lib/endpoints';
import { PeerLink } from '../../../lib/link';
import { toRtcIceServers } from '../../../lib/peer';
import { SessionControllerBase, type BaseSnap, type GetUserMedia } from '../../../lib/sessionBase';
import type { SignalClient } from '../../../lib/signal';
import { EMPTY_STATS, computeNetStats, type NetStats } from '../../../lib/stats';
import { asClient } from '../../../lib/wire';
import type { ConsolePhase } from '../controller';
import type { AnyReport } from './controlClient';
import { MirrorPlane, EMPTY_PLANE, type PlaneSnap } from './mirrorPlane';
import { MirrorRecording, type MirrorRecordingSnap } from './mirrorRecording';
import type { MirrorAckMsg } from './mirrorReceiver';
import type { ReplayerBridge } from './replayerBridge';

export type MirrorSnapshot = BaseSnap &
  PlaneSnap &
  MirrorRecordingSnap & {
    phase: ConsolePhase;
    created: SessionCreated | null;
    connectionState: RTCPeerConnectionState;
    level: ConsentLevel | null;
    scope: MirrorScope | null;
    backstage: boolean;
    policy: ExtensionPolicy;
    transport: 'dc' | 'relay' | 'none';
    /** The Desk's socket dropped; the replayers stay up while it resumes (Phase B 3.5). */
    stale: boolean;
    net: NetStats;
    sessionKbps: number | null;
    ended: SessionEnded | null;
  };

const INITIAL: MirrorSnapshot = {
  ...EMPTY_PLANE,
  phase: 'resuming',
  created: null,
  connectionState: 'new',
  chat: [],
  peerTyping: false,
  transfers: [],
  voiceOn: false,
  muted: false,
  peerMuted: null,
  remoteAudio: null,
  notice: null,
  error: null,
  level: null,
  scope: null,
  backstage: false,
  policy: DEFAULT_EXTENSION_POLICY,
  transport: 'none',
  stale: false,
  net: EMPTY_STATS,
  sessionKbps: null,
  ended: null,
  recording: 'idle',
  recordingUsed: false,
  recordingFailure: null,
  uploadProgress: 0,
  recordingResult: null,
};

export type MirrorControllerDeps = {
  signal: SignalClient;
  sessionId: string;
  assist: { id: string; name: string };
  getUserMedia?: GetUserMedia;
  RTCPeerConnectionImpl?: typeof RTCPeerConnection;
  bridge?: ReplayerBridge;
  report?: (r: AnyReport) => Promise<unknown>;
};

const SHOWN_ERRORS = ['forbidden', 'session_not_found', 'bad_state', 'consent_required', 'relay_closed'];
const STATS_MS = 2500;
const RELAY_STALE_MS = 3000;

export class MirrorConsoleController extends SessionControllerBase<MirrorSnapshot> {
  readonly plane: MirrorPlane;
  readonly rec: MirrorRecording;
  private offs: (() => void)[] = [];
  private timers: ReturnType<typeof setInterval>[] = [];
  private iceServers: RTCIceServer[] = [];
  private everConnected = false;
  private lastRelayAt = 0;
  private statTick = 0;
  private lastTransportBytes: { at: number; bytes: number } | null = null;

  constructor(private readonly deps: MirrorControllerDeps) {
    super(INITIAL, 'assist', deps.getUserMedia);
    this.rec = new MirrorRecording({
      sessionId: deps.sessionId,
      assist: () => deps.assist,
      tabs: () => this.snap.tabs.tabs,
      recordRevealed: () => this.snap.policy.recordRevealed,
      set: (p) => this.set(p),
      isUsed: () => this.snap.recordingUsed,
      sendCtrl: (recording) => void this.link?.send({ t: 'recording.state', recording, ts: Date.now() }),
    });
    const report = deps.report ?? ((r: AnyReport) => sessionsApi.p2Event(deps.sessionId, r as { action: string; data: Record<string, unknown> }));
    this.plane = new MirrorPlane({
      sessionId: deps.sessionId,
      get: () => this.snap,
      set: (p) => this.set(p),
      sendMirror: (m) => this.sendMirror(m),
      sendDc: (m) => this.sendControlDc(m),
      sendRelay: (m) => this.snap.policy.allowRelayFallback && this.deps.signal.send(asClient({ t: 'control.relay', sessionId: this.id, msg: m })),
      report,
      recorder: () => this.rec.recorder,
      bridge: deps.bridge,
      onFirstSnapshot: () => {
        if (this.snap.policy.recordMirror && !this.snap.recordingUsed) this.rec.start();
      },
    });
  }

  protected signalClient(): SignalClient {
    return this.deps.signal;
  }

  protected currentSessionId(): string {
    return this.deps.sessionId;
  }

  private get id(): string {
    return this.deps.sessionId;
  }

  start(cached: SessionCreated | undefined, helloReady: boolean): void {
    const s = this.deps.signal;
    const mine = <T extends { sessionId?: string }>(fn: (m: T) => void) => (m: T) => {
      if (m.sessionId === this.id) fn(m);
    };
    this.offs.push(
      s.on('assist.hello.ok', () => this.resume()),
      s.on('session.created', mine((m: SessionCreated) => this.onCreated(m))),
      s.on('consent.changed', mine((m) => {
        if (m.state === 'granted') {
          this.set({ level: isConsentLevel(m.level) ? m.level : this.snap.level, scope: m.scope ?? this.snap.scope, backstage: m.backstage ?? this.snap.backstage, notice: null });
          if (this.snap.phase !== 'live') this.set({ phase: 'connecting' });
          this.ensureLink();
        } else if (m.state === 'revoked') {
          this.teardown();
          this.set({ notice: 'The Desk revoked consent.', level: null });
        }
      })),
      s.on('webrtc.offer', mine((m) => {
        // Y23: a restart offer (new PC on the Desk), or any offer once our own PC has dropped, needs a new PC here.
        const st = this.link?.peer.pc.connectionState;
        if (this.link && (m.restart === true || (this.everConnected && st !== 'connected'))) this.rebuildLink();
        this.ensureLink();
        void this.link?.handleSignal({ t: 'webrtc.offer', sdp: m.sdp });
      })),
      s.on('webrtc.answer', mine((m) => void this.link?.handleSignal({ t: 'webrtc.answer', sdp: m.sdp }))),
      s.on('webrtc.ice', mine((m) => void this.link?.handleSignal({ t: 'webrtc.ice', candidate: m.candidate }))),
      s.on('desk.reconnected', mine((m) => {
        if (m.state === 'active') this.set({ stale: true, notice: 'The Desk is reconnecting. The view stays until it is back.' });
        else if (m.state === 'consent_pending') {
          this.teardown();
          this.set({ phase: 'waiting_consent', notice: 'The Desk reconnected and must consent again.' });
        }
      })),
      s.on('ice.refresh', mine((m) => {
        this.iceServers = toRtcIceServers(m.iceServers);
        this.link?.peer.refreshIce(this.iceServers, false);
      })),
      s.on('mirror.relay', mine((m) => {
        this.lastRelayAt = Date.now();
        if (this.snap.transport !== 'relay' && !this.link?.hub.isOpen('ia.mirror')) this.set({ transport: 'relay' });
        this.plane.pushRelay(m);
      })),
      s.on('control.relay', mine((m) => this.plane.control.handle(m.msg))),
      s.on('chat.message', mine((m) => this.receiveChat(m))),
      s.on('session.ended', mine((m: SessionEnded) => {
        this.teardown();
        this.set({ phase: 'ended', ended: m });
      })),
      s.on('error', (m) => {
        if (SHOWN_ERRORS.includes(m.code)) this.set({ error: m.message || m.code });
      }),
    );
    this.timers.push(
      setInterval(() => this.plane.tick(), 1000),
      setInterval(() => void this.sampleStats(), STATS_MS),
    );
    if (cached) this.onCreated(cached);
    else if (helloReady) this.resume();
  }

  private resume(): void {
    if (this.snap.phase === 'ended' || this.snap.phase === 'ending') return;
    this.deps.signal.send({ t: 'assist.resume', sessionId: this.id });
  }

  private onCreated(m: SessionCreated): void {
    this.iceServers = toRtcIceServers(m.iceServers ?? []);
    this.set({ created: m, error: null, policy: m.extension ? mergePolicy(m.extension.policy) : this.snap.policy });
    if (m.state === 'active') {
      if (this.link) this.plane.linkRebuilt();
      this.closeLink();
      this.set({ phase: 'connecting' });
      this.ensureLink();
    } else if (m.state === 'ended') this.set({ phase: 'ended' });
    else {
      this.closeLink();
      this.set({ phase: 'waiting_consent' });
    }
  }

  private sendMirror(m: MirrorAckMsg): void {
    if (this.link?.hub.isOpen('ia.mirror')) {
      this.link.send(m);
      return;
    }
    if (!this.snap.policy.allowRelayFallback || Date.now() - this.lastRelayAt > 10_000) return;
    const data = base64urlEncode(utf8Encode(JSON.stringify(m)));
    this.deps.signal.send(asClient({ t: 'mirror.relay', sessionId: this.id, tabId: 0, seq: 0, kind: 'json', enc: 'none', part: 1, parts: 1, data }));
  }

  private sendControlDc(m: ControlRequest): boolean {
    return this.link?.hub.isOpen('ia.control') === true && this.link.send(m);
  }

  private ensureLink(): void {
    if (this.link && !this.link.isClosed) return;
    const link = new PeerLink({
      side: 'assist',
      sessionId: this.id,
      polite: this.snap.created?.polite ?? true,
      iceServers: this.iceServers,
      signal: this.deps.signal,
      createChannels: false,
      RTCPeerConnectionImpl: this.deps.RTCPeerConnectionImpl,
      attest: async (action, data) => {
        await sessionsApi.fileEvent(this.id, action, data);
        return true;
      },
      events: {
        onTrack: (track) => {
          if (track.kind === 'audio') this.set({ remoteAudio: new MediaStream([track]) });
        },
        onConnectionState: (st) => {
          if (st === 'connected') this.everConnected = true;
          this.set({ connectionState: st, ...(st === 'connected' ? { phase: 'live' as const, stale: false } : {}) });
        },
        onChannelOpen: (label) => {
          if (label === 'ia.chat') this.deps.signal.send({ t: 'chat.channel_open', sessionId: this.id });
          if (label === 'ia.mirror') this.set({ transport: 'dc', stale: false, notice: null });
          if (label !== 'ia.ctrl') return;
          if (this.mic) this.sendVoiceState();
          link.send({ t: 'recording.state', recording: this.rec.recorder !== null, ts: Date.now() });
        },
        onMirrorJson: (m) => this.plane.mirrorJson(m),
        onMirrorBinary: (f) => this.plane.pushBinary(f),
        onControl: (m) => this.plane.control.handle(m),
        onChat: (m) => this.receiveChat(m),
        onTyping: (active) => this.set({ peerTyping: active }),
        onTransfers: (list) => this.set({ transfers: [...this.oldTransfers, ...list] }),
        onCtrl: (m) => {
          if (m.t === 'voice.state') this.set({ peerMuted: m.muted });
          else if (m.t === 'stop.sharing') this.set({ notice: 'The Desk stopped sharing.' });
          else if (m.t === 'consent.revoked') this.set({ notice: 'The Desk revoked consent.' });
        },
      },
    });
    this.link = link;
    const track = this.mic?.getAudioTracks()[0];
    if (track && this.mic) link.addTrack(track, this.mic);
  }

  /** Hard rule 2 minus consent state and the mirror recorder (Phase B 3.5): only the link is replaced. */
  private rebuildLink(): void {
    this.closeLink();
    this.everConnected = false;
    this.lastTransportBytes = null;
    this.plane.linkRebuilt();
    this.set({ stale: true, transport: Date.now() - this.lastRelayAt < RELAY_STALE_MS ? 'relay' : 'none' });
  }

  protected override closeLink(): void {
    const had = this.link !== null;
    super.closeLink();
    if (had) this.set({ connectionState: 'closed' });
  }

  /** Hard rule 2: stop the recorder (and upload it), stop the microphone, close everything. */
  teardown(): void {
    this.plane.control.flushInputs();
    if (this.rec.recorder) void this.rec.stop(false);
    this.closeLink();
    this.stopMic();
    this.set({ transport: 'none' });
  }

  private async sampleStats(): Promise<void> {
    const link = this.link;
    if (!link || link.isClosed) return;
    try {
      const report = await link.peer.getStats();
      const net = computeNetStats(report, this.snap.net);
      let bytes = 0;
      report.forEach((v: { type?: string; bytesReceived?: number; bytesSent?: number }) => {
        if (v.type === 'transport') bytes += (v.bytesReceived ?? 0) + (v.bytesSent ?? 0);
      });
      const at = Date.now();
      const prev = this.lastTransportBytes;
      const sessionKbps = prev && at > prev.at ? Math.round(((bytes - prev.bytes) * 8) / (at - prev.at)) : null;
      this.lastTransportBytes = { at, bytes };
      this.set({ net, sessionKbps });
      if (++this.statTick % 2 === 0) this.sendStats(net, sessionKbps);
    } catch {
      /* closed between ticks */
    }
  }

  private sendStats(net: NetStats, sessionKbps: number | null): void {
    const s = this.snap;
    const msg: Record<string, unknown> & { t: string } = {
      t: 'session.stats',
      sessionId: this.id,
      path: net.path,
      rttMs: net.rttMs,
      codec: null,
      bitrateKbps: null,
      fps: null,
      width: null,
      height: null,
      packetsLost: net.packetsLost === null ? null : Math.round(net.packetsLost),
      ts: Date.now(),
      mirrorKbps: s.mirrorKbps,
      mirrorTabs: s.tabs.tabs.filter((t) => t.mirrored === 'yes').length,
    };
    if (s.transport !== 'none') msg.mirrorTransport = s.transport;
    if (sessionKbps !== null && sessionKbps >= 0) msg.sessionKbps = sessionKbps;
    this.deps.signal.send(asClient(msg));
  }

  // ---------- recording ----------

  startRecording(): void {
    this.rec.start();
  }

  stopRecording(): Promise<void> {
    return this.rec.stop(true);
  }

  retryUpload(): Promise<void> {
    return this.rec.retryUpload();
  }

  async endSession(note?: string): Promise<void> {
    this.teardown();
    this.set({ phase: 'ending' });
    if (this.deps.signal.isOpen) {
      this.deps.signal.send({ t: 'session.end', sessionId: this.id, ...(note ? { note } : {}) });
      return;
    }
    try {
      await sessionsApi.end(this.id, note);
      this.set({ phase: 'ended' });
    } catch (e) {
      this.set({ error: errorMessage(e) });
    }
  }

  dispose(): void {
    this.teardown();
    this.plane.dispose();
    for (const off of this.offs) off();
    this.offs = [];
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.stopListening();
  }
}
